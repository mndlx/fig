import Keycloak from 'keycloak-js'

/**
 * Accesso con Keycloak (OIDC, flusso authorization code + PKCE).
 * Con VITE_AUTH_DISABLED=1 l'app gira senza login, per lo sviluppo locale
 * insieme a AUTH_DISABLED=1 sul server.
 */
const AUTH_DISABLED = import.meta.env.VITE_AUTH_DISABLED === '1'

const keycloak = AUTH_DISABLED
  ? null
  : new Keycloak({
      url: import.meta.env.VITE_OIDC_URL ?? 'https://identity.vlabstudio.net',
      realm: import.meta.env.VITE_OIDC_REALM ?? 'virtual-systems',
      clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? 'fig',
    })

export interface User {
  sub: string
  name?: string
  email?: string
}

export type AuthState =
  | { status: 'signed-in'; user: User }
  /** Senza rete o con il servizio di login irraggiungibile: si usa l'app con i dati locali. */
  | { status: 'offline' }
  | { status: 'error' }

let user: User | null = null

export async function initAuth(): Promise<AuthState> {
  if (!keycloak) {
    user = { sub: 'dev-user', name: 'Dev', email: 'dev@localhost' }
    return { status: 'signed-in', user }
  }
  try {
    // "login-required": se non c'è una sessione, si va alla pagina di login di Keycloak e si torna qui.
    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    })
    if (!authenticated || !keycloak.tokenParsed?.sub) return { status: 'error' }
    const p = keycloak.tokenParsed as { sub: string; name?: string; preferred_username?: string; email?: string }
    user = { sub: p.sub, name: p.name ?? p.preferred_username, email: p.email }
    return { status: 'signed-in', user }
  } catch {
    return navigator.onLine ? { status: 'error' } : { status: 'offline' }
  }
}

export function currentUser(): User | null {
  return user
}

export function authEnabled(): boolean {
  return keycloak !== null
}

/** Token valido per le API, rinnovato se scade entro 30 secondi. Null se non si è autenticati. */
export async function getToken(): Promise<string | null> {
  if (!keycloak) return null
  if (!keycloak.authenticated) return null
  try {
    await keycloak.updateToken(30)
    return keycloak.token ?? null
  } catch {
    return null
  }
}

export function signIn() {
  if (keycloak) void keycloak.login()
  else location.reload()
}

export function signOut() {
  if (keycloak) void keycloak.logout({ redirectUri: `${location.origin}/` })
}
