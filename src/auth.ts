/**
 * Accesso: lo gestisce il server (Keycloak, client confidenziale). La pagina chiede
 * "chi sono?" a /api/me; se non c'è una sessione va a /auth/login, che porta a Keycloak
 * e torna con un cookie HttpOnly. Nessun token passa dal JavaScript.
 */

export interface User {
  sub: string
  name?: string
  email?: string
}

export type AuthState =
  | { status: 'signed-in'; user: User }
  /** Senza rete: si usa l'app con i dati locali. */
  | { status: 'offline' }
  | { status: 'error' }

let user: User | null = null
let mode: 'oidc' | 'disabled' = 'oidc'

export function signIn() {
  location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname)}`
}

export async function initAuth(): Promise<AuthState> {
  let res: Response
  try {
    res = await fetch('/api/me', { credentials: 'same-origin' })
  } catch {
    return { status: 'offline' }
  }
  if (res.status === 401) {
    signIn()
    // La pagina sta per andare a Keycloak: non c'è altro da fare.
    return new Promise(() => {})
  }
  if (!res.ok) return { status: 'error' }
  const me = (await res.json()) as User & { auth?: 'oidc' | 'disabled' }
  mode = me.auth ?? 'oidc'
  user = { sub: me.sub, name: me.name, email: me.email }
  return { status: 'signed-in', user }
}

export function currentUser(): User | null {
  return user
}

export function authEnabled(): boolean {
  return mode === 'oidc'
}

export async function signOut() {
  let url = '/'
  try {
    const res = await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    url = ((await res.json()) as { url?: string }).url ?? '/'
  } catch {
    /* offline: si esce comunque dall'app */
  }
  location.href = url
}
