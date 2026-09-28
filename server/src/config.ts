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

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** File del database SQLite. */
  dbPath: path.resolve(process.env.DB_PATH ?? 'data/fig.db'),
  /** Issuer OIDC, es. https://identity.vlabstudio.net/realms/<realm>. */
  issuer: (process.env.OIDC_ISSUER ?? '').replace(/\/$/, ''),
  /** Client dell'app su Keycloak: i token devono essere emessi per lui (claim azp o aud). */
  clientId: process.env.OIDC_CLIENT_ID ?? 'fig',
  /** Solo per sviluppo locale: salta la verifica del token e usa un utente fisso. */
  authDisabled: process.env.AUTH_DISABLED === '1',
  /** Cartella del frontend compilato, servita insieme alle API. */
  staticDir: path.resolve(process.env.STATIC_DIR ?? '../dist'),
}
