import { Router } from 'express'
import { config } from './config.ts'
import type { Db } from './db.ts'

/** Tabelle dell'app che si sincronizzano. Tutto il resto viene rifiutato. */
const TABLES = new Set(['settings', 'currencies', 'accounts', 'categories', 'goals', 'transactions', 'rules', 'importProfiles', 'recurring'])
const MAX_CHANGES = 5000
const MAX_RECORD_BYTES = 64 * 1024
const PAGE = 2000

interface Change {
  tbl: string
  id: string
  data?: unknown
  deleted?: boolean
}

function validChange(c: unknown): c is Change {
  if (!c || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  if (typeof x.tbl !== 'string' || !TABLES.has(x.tbl)) return false
  if (typeof x.id !== 'string' || !x.id || x.id.length > 200) return false
  if (x.deleted) return true
  return !!x.data && typeof x.data === 'object' && JSON.stringify(x.data).length <= MAX_RECORD_BYTES
}

export function syncRouter(db: Db) {
  const router = Router()

  const touchUser = db.prepare(`
    INSERT INTO users (id, email, name, rev, created_at, last_seen) VALUES (@id, @email, @name, 0, @now, @now)
    ON CONFLICT(id) DO UPDATE SET email = COALESCE(@email, email), name = COALESCE(@name, name), last_seen = @now
  `)
  const nextRev = db.prepare(`UPDATE users SET rev = rev + 1 WHERE id = ? RETURNING rev`)
  const currentRev = db.prepare(`SELECT rev FROM users WHERE id = ?`)
  const upsert = db.prepare(`
    INSERT INTO records (user_id, tbl, id, data, deleted, rev, updated_at) VALUES (@user, @tbl, @id, @data, @deleted, @rev, @now)
    ON CONFLICT(user_id, tbl, id) DO UPDATE SET data = @data, deleted = @deleted, rev = @rev, updated_at = @now
  `)
  const changesSince = db.prepare(`
    SELECT tbl, id, data, deleted, rev FROM records WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT ?
  `)

  router.get('/me', (req, res) => {
    const user = req.user!
    touchUser.run({ id: user.sub, email: user.email ?? null, name: user.name ?? null, now: Date.now() })
    res.json({ sub: user.sub, email: user.email, name: user.name, auth: config.authDisabled ? 'disabled' : 'oidc' })
  })

  /**
   * Un solo scambio: il dispositivo manda le sue modifiche e il cursore dell'ultima
   * sincronizzazione, il server le salva e restituisce ciò che è cambiato altrove.
   * Vince l'ultima scrittura arrivata al server.
   */
  router.post('/sync', (req, res) => {
    const user = req.user!
    const since = Number(req.body?.since ?? 0)
    const changes: unknown[] = Array.isArray(req.body?.changes) ? req.body.changes : []
    if (!Number.isInteger(since) || since < 0) return res.status(400).json({ error: 'bad_since' })
    if (changes.length > MAX_CHANGES) return res.status(413).json({ error: 'too_many_changes' })
    if (!changes.every(validChange)) return res.status(400).json({ error: 'bad_change' })

    const now = Date.now()
    const pushed = new Set<number>()
    db.transaction(() => {
      touchUser.run({ id: user.sub, email: user.email ?? null, name: user.name ?? null, now })
      for (const c of changes as Change[]) {
        const { rev } = nextRev.get(user.sub) as { rev: number }
        pushed.add(rev)
        upsert.run({
          user: user.sub,
          tbl: c.tbl,
          id: c.id,
          data: c.deleted ? null : JSON.stringify(c.data),
          deleted: c.deleted ? 1 : 0,
          rev,
          now,
        })
      }
    })()

    const rows = changesSince.all(user.sub, since, PAGE + 1) as { tbl: string; id: string; data: string | null; deleted: number; rev: number }[]
    const more = rows.length > PAGE
    const page = rows.slice(0, PAGE)
    const { rev: latest } = currentRev.get(user.sub) as { rev: number }
    res.json({
      // Se ci sono altre pagine, il cursore si ferma all'ultima riga inviata.
      rev: more ? page[page.length - 1].rev : latest,
      more,
      changes: page
        .filter((r) => !pushed.has(r.rev))
        .map((r) => ({ tbl: r.tbl, id: r.id, deleted: !!r.deleted, data: r.data ? JSON.parse(r.data) : undefined })),
    })
  })

  return router
}
