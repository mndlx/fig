import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { authRouter, requireAuth } from './auth.ts'
import { config } from './config.ts'
import { openDb } from './db.ts'
import { syncRouter } from './sync.ts'

const db = openDb(config.dbPath)
const app = express()
app.disable('x-powered-by')
// Dietro nginx: serve per riconoscere HTTPS e l'IP reale.
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, auth: config.authDisabled ? 'disabled' : config.issuer && config.clientSecret ? 'oidc' : 'not_configured' })
})
app.use('/auth', authRouter(db))
app.use('/api', requireAuth(db), syncRouter(db))
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }))

// In produzione lo stesso server distribuisce il frontend compilato.
if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }))
  app.get(/.*/, (_req, res) => res.sendFile(path.join(config.staticDir, 'index.html')))
}

app.listen(config.port, () => {
  console.log(`FIG server on http://localhost:${config.port}`)
  console.log(`  public url: ${config.publicUrl} (redirect ${config.publicUrl}/auth/callback)`)
  console.log(`  database:   ${config.dbPath}`)
  if (config.authDisabled) console.warn('  AUTH_DISABLED=1: every request is "dev-user". Never use this in production.')
  else if (!config.issuer) console.warn('  OIDC_ISSUER is not set: sign-in will fail.')
  else if (!config.clientSecret) console.warn('  OIDC_CLIENT_SECRET is not set: sign-in will fail.')
  else console.log(`  identity:   ${config.issuer} (client ${config.clientId})`)
})
