import type { NextFunction, Request, Response } from 'express'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { config } from './config.ts'

export interface AuthUser {
  sub: string
  email?: string
  name?: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

/** Chiavi pubbliche del realm, scoperte dalla configurazione OIDC (e messe in cache da jose). */
async function getJwks() {
  if (jwks) return jwks
  const res = await fetch(`${config.issuer}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
  const meta = (await res.json()) as { jwks_uri: string }
  jwks = createRemoteJWKSet(new URL(meta.jwks_uri))
  return jwks
}

/** Keycloak mette il client in "azp"; "aud" può contenere solo "account". Accettiamo l'uno o l'altro. */
function issuedForClient(payload: JWTPayload): boolean {
  const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  return payload.azp === config.clientId || aud.includes(config.clientId)
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (config.authDisabled) {
    req.user = { sub: 'dev-user', email: 'dev@localhost', name: 'Dev' }
    return next()
  }
  if (!config.issuer) return res.status(503).json({ error: 'auth_not_configured' })

  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'missing_token' })

  try {
    const { payload } = await jwtVerify(token, await getJwks(), { issuer: config.issuer })
    if (!payload.sub || !issuedForClient(payload)) return res.status(401).json({ error: 'wrong_client' })
    req.user = {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    }
    next()
  } catch {
    res.status(401).json({ error: 'invalid_token' })
  }
}
