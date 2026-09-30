import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

// Configurazione di prova, impostata prima di caricare il server: login vero (niente AUTH_DISABLED)
// e nessun identity provider raggiungibile, così i test non escono mai in rete.
process.env.AUTH_DISABLED = '0'
process.env.OIDC_ISSUER = ''
process.env.PUBLIC_URL = 'http://localhost'

const { default: express } = await import('express')
const { accountRouter, requireAuth } = await import('../src/auth.ts')
const { openDb } = await import('../src/db.ts')
const { syncRouter } = await import('../src/sync.ts')

const db = openDb(':memory:')
const app = express()
app.use(express.json())
app.use('/api', requireAuth(db), syncRouter(db), accountRouter(db))

let base = ''
const server = app.listen(0)
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

/** Utente con una sessione valida; restituisce il cookie da mandare. */
function signIn(sub: string): string {
  const now = Date.now()
  db.prepare(`INSERT OR IGNORE INTO users (id, rev, created_at, last_seen) VALUES (?, 0, ?, ?)`).run(sub, now, now)
  const sid = `sid-${sub}-${Math.random()}`
  db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(sid, sub, now, now + 86_400_000)
  return `fig_session=${sid}`
}

async function post(path: string, cookie: string | null, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

const expense = (id: string, amount: number) => ({ tbl: 'transactions', id, data: { id, kind: 'expense', amount } })

test('senza sessione le API rispondono 401', async () => {
  assert.equal((await post('/api/sync', null, { since: 0, changes: [] })).status, 401)
  assert.equal((await post('/api/sync', 'fig_session=inventata', { since: 0, changes: [] })).status, 401)
})

test('le scritture devono essere JSON (niente form da altri siti)', async () => {
  const cookie = signIn('form-user')
  const res = await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: 'a=1' })
  assert.equal(res.status, 415)
})

test('sincronizzazione tra due dispositivi dello stesso utente', async () => {
  const phone = signIn('anna')
  const laptop = signIn('anna')
  const first = await post('/api/sync', phone, { since: 0, changes: [expense('t1', 1250)] })
  assert.equal(first.status, 200)
  // Chi ha inviato non riceve indietro le proprie modifiche.
  assert.deepEqual(first.body.changes, [])

  const other = await post('/api/sync', laptop, { since: 0, changes: [] })
  assert.equal(other.body.changes.length, 1)
  assert.equal(other.body.changes[0].data.amount, 1250)

  // Eliminazione: arriva agli altri dispositivi come "deleted".
  await post('/api/sync', laptop, { since: other.body.rev, changes: [{ tbl: 'transactions', id: 't1', deleted: true }] })
  const again = await post('/api/sync', phone, { since: first.body.rev, changes: [] })
  assert.deepEqual(again.body.changes, [{ tbl: 'transactions', id: 't1', deleted: true }])
})

test('ogni utente vede solo i propri dati', async () => {
  const mario = signIn('mario')
  const luca = signIn('luca')
  await post('/api/sync', mario, { since: 0, changes: [expense('segreto', 999)] })
  const seen = await post('/api/sync', luca, { since: 0, changes: [] })
  assert.equal(seen.body.changes.length, 0)
})

test('tabelle sconosciute e record malformati vengono rifiutati', async () => {
  const cookie = signIn('eve')
  assert.equal((await post('/api/sync', cookie, { since: 0, changes: [{ tbl: 'users', id: 'x', data: {} }] })).status, 400)
  assert.equal((await post('/api/sync', cookie, { since: 0, changes: [{ tbl: 'transactions', id: '', data: {} }] })).status, 400)
  assert.equal((await post('/api/sync', cookie, { since: -1, changes: [] })).status, 400)
})

test("cancellazione dell'account: serve la conferma, poi spariscono dati e sessioni", async () => {
  const phone = signIn('giulia')
  const tablet = signIn('giulia')
  await post('/api/sync', phone, { since: 0, changes: [expense('g1', 100), expense('g2', 200)] })
  const bystander = signIn('paolo')
  await post('/api/sync', bystander, { since: 0, changes: [expense('p1', 300)] })

  assert.equal((await post('/api/account/delete', phone, {})).status, 400)

  const res = await post('/api/account/delete', phone, { confirm: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.url, '/')

  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n
  assert.equal(count(`SELECT COUNT(*) n FROM users WHERE id = ?`, 'giulia'), 0)
  assert.equal(count(`SELECT COUNT(*) n FROM records WHERE user_id = ?`, 'giulia'), 0)
  assert.equal(count(`SELECT COUNT(*) n FROM sessions WHERE user_id = ?`, 'giulia'), 0)
  // Anche l'altro dispositivo è fuori.
  assert.equal((await post('/api/sync', tablet, { since: 0, changes: [] })).status, 401)
  // Gli altri utenti non vengono toccati.
  assert.equal(count(`SELECT COUNT(*) n FROM records WHERE user_id = ?`, 'paolo'), 1)
})
