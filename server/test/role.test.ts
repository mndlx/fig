import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

// Il ruolo di FIG al login, contro un Keycloak finto in locale (discovery, chiavi, token endpoint):
// il login vero, dalla redirect alla callback, senza uscire in rete.
const { default: express } = await import('express')

const { publicKey, privateKey } = await generateKeyPair('RS256')
const other = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }

/** Cosa mette il Keycloak finto nell'access token del prossimo login. */
interface Grant {
  sub: string
  resourceAccess?: Record<string, { roles: string[] }>
  azp?: string
  signWith?: CryptoKey
}
let grant: Grant = { sub: 'nessuno' }
let nonce = ''
let issuer = ''

const realm = express.Router()
realm.get('/.well-known/openid-configuration', (_req, res) =>
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
  }),
)
realm.get('/protocol/openid-connect/certs', (_req, res) => res.json({ keys: [jwk] }))
realm.post('/protocol/openid-connect/token', express.urlencoded({ extended: false }), async (req, res) => {
  if (req.body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' })
  const header = { alg: 'RS256', kid: 'k1' }
  const id_token = await new SignJWT({ nonce, email: `${grant.sub}@example.test`, name: grant.sub })
    .setProtectedHeader(header).setIssuer(issuer).setAudience('fig').setSubject(grant.sub).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey)
  const access_token = await new SignJWT({ azp: grant.azp ?? 'fig', resource_access: grant.resourceAccess ?? {} })
    .setProtectedHeader(header).setIssuer(issuer).setAudience('account').setSubject(grant.sub).setIssuedAt().setExpirationTime('5m')
    .sign(grant.signWith ?? privateKey)
  res.json({ id_token, access_token, token_type: 'Bearer' })
})
const keycloak = express().use('/realms/test', realm).listen(0)
await once(keycloak, 'listening')
issuer = `http://127.0.0.1:${(keycloak.address() as AddressInfo).port}/realms/test`

process.env.AUTH_DISABLED = '0'
process.env.OIDC_ISSUER = issuer
process.env.OIDC_CLIENT_ID = 'fig'
process.env.OIDC_CLIENT_SECRET = 'segreto-di-prova'
process.env.PUBLIC_URL = 'http://localhost'
delete process.env.OIDC_REQUIRED_ROLE

const { authRouter, clientRoles } = await import('../src/auth.ts')
const { openDb } = await import('../src/db.ts')

const db = openDb(':memory:')
const app = express().use('/auth', authRouter(db)).listen(0)
await once(app, 'listening')
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
after(() => {
  app.close()
  keycloak.close()
})

/** Login completo: /auth/login, poi la callback con lo state del cookie, come fa il browser. */
async function signIn(g: Grant) {
  grant = g
  const start = await fetch(`${base}/auth/login`, { redirect: 'manual' })
  const to = new URL(start.headers.get('location')!)
  nonce = to.searchParams.get('nonce')!
  const state = to.searchParams.get('state')!
  const loginCookie = start.headers.getSetCookie().find((c) => c.startsWith('fig_login='))!.split(';')[0]
  const back = await fetch(`${base}/auth/callback?code=codice&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { Cookie: loginCookie },
  })
  return {
    status: back.status,
    location: back.headers.get('location'),
    session: back.headers.getSetCookie().some((c) => /^fig_session=[^;]+/.test(c) && !c.startsWith('fig_session=;')),
    body: await back.text(),
  }
}

const rows = (sub: string) => ({
  users: (db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(sub) as { n: number }).n,
  sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(sub) as { n: number }).n,
})

test('con il ruolo «access» del client fig si entra: sessione e utente', async () => {
  const r = await signIn({ sub: 'mariano', resourceAccess: { fig: { roles: ['access'] }, account: { roles: ['view-profile'] } } })
  assert.equal(r.status, 302)
  assert.equal(r.location, '/')
  assert.ok(r.session)
  assert.deepEqual(rows('mariano'), { users: 1, sessions: 1 })
})

test('senza ruoli: 403, nessuna sessione e nemmeno una riga in users', async () => {
  const r = await signIn({ sub: 'amico' })
  assert.equal(r.status, 403)
  assert.equal(r.session, false)
  assert.match(r.body, /non ha accesso a FIG/)
  // L'uscita porta a Keycloak, per poter entrare con un altro account.
  assert.match(r.body, new RegExp(`href="${issuer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/protocol/openid-connect/logout\\?`))
  assert.deepEqual(rows('amico'), { users: 0, sessions: 0 })
})

test("il ruolo «access» di un'altra app (linnet) non vale per FIG", async () => {
  const r = await signIn({ sub: 'amico-linnet', resourceAccess: { linnet: { roles: ['access'] } } })
  assert.equal(r.status, 403)
  assert.deepEqual(rows('amico-linnet'), { users: 0, sessions: 0 })
})

test('un altro ruolo del client fig non basta', async () => {
  const r = await signIn({ sub: 'amico-ospite', resourceAccess: { fig: { roles: ['ospite'] } } })
  assert.equal(r.status, 403)
  assert.deepEqual(rows('amico-ospite'), { users: 0, sessions: 0 })
})

test('access token emesso per un altro client, anche se dice fig.access: rifiutato', async () => {
  const r = await signIn({ sub: 'amico-azp', azp: 'linnet', resourceAccess: { fig: { roles: ['access'] } } })
  assert.equal(r.status, 403)
  assert.deepEqual(rows('amico-azp'), { users: 0, sessions: 0 })
})

test('access token firmato da una chiave che non è del realm: rifiutato', async () => {
  const r = await signIn({ sub: 'amico-chiave', resourceAccess: { fig: { roles: ['access'] } }, signWith: other.privateKey })
  assert.equal(r.status, 403)
  assert.deepEqual(rows('amico-chiave'), { users: 0, sessions: 0 })
})

test('clientRoles legge solo i ruoli del client chiesto, e solo stringhe', () => {
  assert.deepEqual(clientRoles({ resource_access: { fig: { roles: ['access', 3, null] }, linnet: { roles: ['x'] } } }, 'fig'), ['access'])
  assert.deepEqual(clientRoles({ resource_access: { linnet: { roles: ['access'] } } }, 'fig'), [])
  assert.deepEqual(clientRoles({ realm_access: { roles: ['access'] } }, 'fig'), [])
  assert.deepEqual(clientRoles({ resource_access: 'access' }, 'fig'), [])
  assert.deepEqual(clientRoles({}, 'fig'), [])
})
