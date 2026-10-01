/**
 * Accesso: lo gestisce il server (Keycloak, client confidenziale). La pagina chiede
 * "chi sono?" a /api/me; se non c'è una sessione si sceglie se accedere (/auth/login,
 * che porta a Keycloak e torna con un cookie HttpOnly) o usare FIG senza account,
 * con i dati solo sul dispositivo. Nessun token passa dal JavaScript.
 */

export interface User {
  sub: string
  name?: string
  email?: string
  /** Pagina del servizio di identità dove si modificano nome, cognome, email e password. */
  accountUrl?: string
}

export type AuthState =
  | { status: 'signed-in'; user: User }
  /** Nessuna sessione: si accede oppure, se il server lo permette, si usa FIG senza account. */
  | { status: 'signed-out'; localMode: boolean }
  /** Senza rete: si usa l'app con i dati locali. */
  | { status: 'offline' }
  | { status: 'error' }
  /** La pagina c'è ma il server FIG non risponde (in sviluppo: server/ non avviato). */
  | { status: 'server-down' }

let user: User | null = null
let mode: 'oidc' | 'disabled' = 'oidc'

/** Modalità senza account: scelta su questo dispositivo, finché non si accede. */
const LOCAL_KEY = 'fig-local'

export function isLocalOnly(): boolean {
  try {
    return localStorage.getItem(LOCAL_KEY) === '1'
  } catch {
    return false
  }
}

export function setLocalOnly(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCAL_KEY, '1')
    else localStorage.removeItem(LOCAL_KEY)
  } catch {
    // Memoria non disponibile: al prossimo avvio si richiede la scelta.
  }
}

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
  if (res.status === 401) return { status: 'signed-out', localMode: await localModeAllowed() }
  if (res.status === 502 || res.status === 503 || res.status === 504) return { status: 'server-down' }
  if (!res.ok) return { status: 'error' }
  const me = (await res.json()) as User & { auth?: 'oidc' | 'disabled' }
  mode = me.auth ?? 'oidc'
  user = { sub: me.sub, name: me.name, email: me.email, accountUrl: me.accountUrl || undefined }
  return { status: 'signed-in', user }
}

/** Il server permette l'uso senza account? (Impostazione LOCAL_MODE; nel dubbio no.) */
async function localModeAllowed(): Promise<boolean> {
  try {
    const res = await fetch('/api/config')
    return res.ok && ((await res.json()) as { localMode?: boolean }).localMode === true
  } catch {
    return false
  }
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

/**
 * Cancella l'account su FIG: tutti i dati sul server, su ogni dispositivo.
 * Restituisce l'indirizzo a cui andare dopo (uscita da Keycloak) oppure lancia un errore.
 */
export async function deleteAccount(): Promise<string> {
  const res = await fetch('/api/account/delete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  })
  if (!res.ok) throw new Error(`delete_${res.status}`)
  return ((await res.json()) as { url?: string }).url ?? '/'
}
