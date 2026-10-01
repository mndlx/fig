import crypto from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from './config.ts'
import type { Db } from './db.ts'

/**
 * Accesso con Keycloak come "backend for frontend": il server fa il flusso OIDC
 * (authorization code + PKCE + client secret) e al browser dà solo un cookie di
 * sessione HttpOnly. Nessun token finisce nel JavaScript della pagina.
 */

export interface AuthUser {
  sub: string
  email?: string
  name?: string
  givenName?: string
  familyName?: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

const COOKIE = 'fig_session'
const STATE_TTL = 10 * 60 * 1000
const DEV_USER: AuthUser = { sub: 'dev-user', email: 'dev@localhost', name: 'Dev' }

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
  jwks_uri: string
}

let discovery: Discovery | null = null
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

async function oidc() {
  if (!discovery) {
    const res = await fetch(`${config.issuer}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
    discovery = (await res.json()) as Discovery
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))
  }
  return { meta: discovery, jwks: jwks! }
}

/**
 * Controllo all'avvio: il server prova le proprie credenziali sul token endpoint.
 * Keycloak risponde "Invalid client credentials" se il secret non è di questo client,
 * "not enabled to retrieve service account" se il secret è giusto (e i service account sono spenti).
 * Il secret non viene mai scritto nel log.
 */
export async function checkClientSecret(): Promise<string> {
  if (config.authDisabled) return 'auth disabled'
  if (!config.issuer || !config.clientSecret) return 'OIDC_CLIENT_SECRET is not set: sign-in will fail'
  try {
    const { meta } = await oidc()
    const res = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    })
    if (res.ok) return 'client secret accepted'
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
    if (/service account/i.test(body.error_description ?? '')) return 'client secret accepted'
    return `client secret REJECTED by Keycloak (${body.error ?? res.status}: ${body.error_description ?? ''}) — check OIDC_CLIENT_SECRET belongs to client "${config.clientId}"`
  } catch (e) {
    return `could not check the client secret: ${e instanceof Error ? e.message : e}`
  }
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')
const redirectUri = () => `${config.publicUrl}/auth/callback`

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ')
}

const LOGIN_COOKIE = 'fig_login'

function loginCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${LOGIN_COOKIE}=${value}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ')
}

/** Solo percorsi interni all'app, per non trasformare il login in un redirect aperto. */
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export function authRouter(db: Db) {
  const router = Router()
  const saveState = db.prepare(`INSERT INTO login_states (state, verifier, nonce, return_to, created_at) VALUES (?, ?, ?, ?, ?)`)
  const takeState = db.prepare(`DELETE FROM login_states WHERE state = ? RETURNING verifier, nonce, return_to, created_at`)
  const purgeStates = db.prepare(`DELETE FROM login_states WHERE created_at < ?`)
  const upsertUser = db.prepare(`
    INSERT INTO users (id, email, name, given_name, family_name, rev, created_at, last_seen) VALUES (@id, @email, @name, @given, @family, 0, @now, @now)
    ON CONFLICT(id) DO UPDATE SET email = COALESCE(@email, email), name = COALESCE(@name, name), given_name = @given, family_name = @family, last_seen = @now
  `)
  const createSession = db.prepare(`INSERT INTO sessions (id, user_id, id_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
  const takeSession = db.prepare(`DELETE FROM sessions WHERE id = ? RETURNING id_token`)
  const purgeSessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`)

  function failure(res: Response, message: string) {
    res.status(500).type('text/plain').send(`FIG sign-in error: ${message}`)
  }

  router.get('/login', async (req, res) => {
    if (config.authDisabled) return res.redirect(safeReturnTo(req.query.returnTo))
    if (!config.issuer || !config.clientSecret) return failure(res, 'OIDC_ISSUER or OIDC_CLIENT_SECRET is not set on the server (.env).')
    try {
      const { meta } = await oidc()
      const state = random()
      const verifier = random(48)
      const nonce = random()
      purgeStates.run(Date.now() - STATE_TTL)
      saveState.run(state, verifier, nonce, safeReturnTo(req.query.returnTo), Date.now())
      const url = new URL(meta.authorization_endpoint)
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        scope: 'openid profile email',
        redirect_uri: redirectUri(),
        state,
        nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString()
      // Il login resta legato a questo browser: la callback accetta solo lo state del suo cookie.
      res.setHeader('Set-Cookie', loginCookie(state, STATE_TTL / 1000))
      res.redirect(url.toString())
    } catch (e) {
      failure(res, e instanceof Error ? e.message : 'discovery failed')
    }
  })

  router.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query as Record<string, string | undefined>
    if (error) return failure(res, `${error}${error_description ? `: ${error_description}` : ''}`)
    if (!code || !state) return failure(res, 'missing code or state')
    // Senza il cookie dello state (link di callback aperto da un altro browser) non si entra: evita il login CSRF.
    const browserState = readCookie(req, LOGIN_COOKIE)
    res.setHeader('Set-Cookie', loginCookie('', 0))
    if (!browserState || browserState !== state) return res.redirect('/auth/login')
    const saved = takeState.get(state) as { verifier: string; nonce: string; return_to: string; created_at: number } | undefined
    if (!saved || Date.now() - saved.created_at > STATE_TTL) return res.redirect('/auth/login')

    try {
      const { meta, jwks } = await oidc()
      const tokenRes = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
          code_verifier: saved.verifier,
        }),
      })
      const tokens = (await tokenRes.json()) as { id_token?: string; error?: string; error_description?: string }
      if (!tokenRes.ok || !tokens.id_token) return failure(res, `token exchange: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ''}`)

      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: meta.issuer, audience: config.clientId })
      if (payload.nonce !== saved.nonce || !payload.sub) return failure(res, 'invalid id token')

      const now = Date.now()
      upsertUser.run({
        id: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        name: typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : null,
        // A ogni accesso valgono quelli attuali: se sono stati tolti dal profilo, qui tornano vuoti.
        given: typeof payload.given_name === 'string' && payload.given_name ? payload.given_name : null,
        family: typeof payload.family_name === 'string' && payload.family_name ? payload.family_name : null,
        now,
      })
      const sessionId = random()
      purgeSessions.run(now)
      createSession.run(sessionId, payload.sub, tokens.id_token, now, now + config.sessionDays * 86_400_000)
      res.append('Set-Cookie', sessionCookie(sessionId, config.sessionDays * 86_400))
      res.redirect(saved.return_to)
    } catch (e) {
      failure(res, e instanceof Error ? e.message : 'callback failed')
    }
  })

  /** Chiude la sessione dell'app e restituisce l'indirizzo per uscire anche da Keycloak. */
  router.post('/logout', async (req, res) => {
    const sid = readCookie(req, COOKIE)
    const row = sid ? (takeSession.get(sid) as { id_token: string | null } | undefined) : undefined
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    res.json({ url: await logoutUrl(row?.id_token) })
  })

  return router
}

/** Indirizzo di uscita da Keycloak (chiude anche la sessione dell'identity provider); '/' se non disponibile. */
async function logoutUrl(idToken?: string | null): Promise<string> {
  if (config.authDisabled) return '/'
  try {
    const { meta } = await oidc()
    if (!meta.end_session_endpoint) return '/'
    const u = new URL(meta.end_session_endpoint)
    u.search = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: `${config.publicUrl}/`,
      ...(idToken ? { id_token_hint: idToken } : {}),
    }).toString()
    return u.toString()
  } catch {
    // Senza discovery si esce solo dall'app.
    return '/'
  }
}

/**
 * Cancellazione dell'account (va montato dopo requireAuth): elimina l'utente con tutti i suoi
 * record e tutte le sessioni, su ogni dispositivo. L'account sull'identity provider non si tocca:
 * lo gestisce Keycloak. Serve la conferma esplicita nel corpo della richiesta.
 */
export function accountRouter(db: Db) {
  const router = Router()
  const sessionToken = db.prepare(`SELECT id_token FROM sessions WHERE id = ?`)
  const deleteUser = db.prepare(`DELETE FROM users WHERE id = ?`)

  router.post('/account/delete', async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required' })
    const sid = readCookie(req, COOKIE)
    const row = sid ? (sessionToken.get(sid) as { id_token: string | null } | undefined) : undefined
    // Record e sessioni se ne vanno con l'utente (ON DELETE CASCADE).
    deleteUser.run(req.user!.sub)
    console.log('account deleted')
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    res.json({ ok: true, url: await logoutUrl(row?.id_token) })
  })

  return router
}

/** Protegge le API: serve una sessione valida; la scadenza si rinnova a ogni utilizzo. */
export function requireAuth(db: Db) {
  const findSession = db.prepare(`
    SELECT s.user_id, u.email, u.name, u.given_name, u.family_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?
  `)
  const extend = db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
  const ensureDevUser = db.prepare(`
    INSERT INTO users (id, email, name, rev, created_at, last_seen) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING
  `)

  return (req: Request, res: Response, next: NextFunction) => {
    // Le richieste che scrivono devono essere JSON: un form di un altro sito non può farlo senza preflight CORS.
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'json_required' })

    if (config.authDisabled) {
      ensureDevUser.run(DEV_USER.sub, DEV_USER.email, DEV_USER.name, Date.now(), Date.now())
      req.user = DEV_USER
      return next()
    }
    const sid = readCookie(req, COOKIE)
    const row = sid ? (findSession.get(sid, Date.now()) as { user_id: string; email: string | null; name: string | null; given_name: string | null; family_name: string | null } | undefined) : undefined
    if (!row) return res.status(401).json({ error: 'not_signed_in' })
    extend.run(Date.now() + config.sessionDays * 86_400_000, sid)
    // Anche il cookie si rinnova, altrimenti scadrebbe comunque dopo SESSION_DAYS dal login.
    res.setHeader('Set-Cookie', sessionCookie(sid!, config.sessionDays * 86_400))
    req.user = {
      sub: row.user_id,
      email: row.email ?? undefined,
      name: row.name ?? undefined,
      givenName: row.given_name ?? undefined,
      familyName: row.family_name ?? undefined,
    }
    next()
  }
}
