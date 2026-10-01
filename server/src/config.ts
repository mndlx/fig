import fs from 'node:fs'
import path from 'node:path'

/** Carica un file .env accanto al server, senza sovrascrivere le variabili già impostate. */
function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadEnvFile(path.resolve('.env'))

const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:5174').replace(/\/$/, '')

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** Indirizzo pubblico dell'app: da qui si costruisce il redirect "/auth/callback" registrato su Keycloak. */
  publicUrl,
  /** Cookie "Secure" solo quando l'app è servita in HTTPS. */
  secureCookies: publicUrl.startsWith('https://'),
  /** File del database SQLite. */
  dbPath: path.resolve(process.env.DB_PATH ?? 'data/fig.db'),
  /** Issuer OIDC, es. https://identity.vlabstudio.net/realms/virtual-systems. */
  issuer: (process.env.OIDC_ISSUER ?? '').replace(/\/$/, ''),
  clientId: process.env.OIDC_CLIENT_ID ?? 'fig',
  /** Secret del client confidenziale su Keycloak (tab "Credentials"). Non va mai nel repository. */
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
  /** Durata della sessione dell'app, rinnovata a ogni utilizzo. */
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Solo per sviluppo locale: salta il login e usa un utente fisso. */
  authDisabled: process.env.AUTH_DISABLED === '1',
  /** Cartella del frontend compilato, servita insieme alle API. */
  staticDir: path.resolve(process.env.STATIC_DIR ?? '../dist'),
  /** Pagina di Keycloak dove l'utente modifica nome, cognome, email e password; torna a FIG a modifica fatta. */
  accountUrl: process.env.OIDC_ISSUER
    ? `${process.env.OIDC_ISSUER.replace(/\/$/, '')}/account/?referrer=${encodeURIComponent(process.env.OIDC_CLIENT_ID ?? 'fig')}&referrer_uri=${encodeURIComponent(publicUrl + '/')}`
    : '',
  /** Uso di FIG senza account (dati solo nel browser). Spento finché LOCAL_MODE non vale 1. */
  localMode: process.env.LOCAL_MODE === '1',
  /** App Android (Trusted Web Activity): pacchetto e impronte SHA-256 dei certificati di firma, separate da virgola. */
  androidPackage: process.env.ANDROID_PACKAGE ?? '',
  androidCertSha256: (process.env.ANDROID_CERT_SHA256 ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
}
