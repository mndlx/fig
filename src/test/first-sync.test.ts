import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../currencyGuess', () => ({ guessCurrency: () => 'EUR' }))

import { db } from '../db'
import { startSync, syncNow } from '../sync'

interface Change {
  tbl: string
  id: string
  deleted?: boolean
  data?: Record<string, unknown>
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

/** Archivio di un utente che usa già FIG in lek su un altro dispositivo. */
const ARCHIVE: Change[] = [
  { tbl: 'settings', id: 'main', data: { id: 'main', mainCurrency: 'ALL', setup: 'done' } },
  { tbl: 'accounts', id: 'acc-main', data: { id: 'acc-main', name: '', key: 'main', currency: 'ALL', initialBalance: 0, initialMain: 0, order: 0, archived: false } },
  { tbl: 'accounts', id: 'acc-cash', data: { id: 'acc-cash', name: '', key: 'cash', currency: 'ALL', initialBalance: 0, initialMain: 0, order: 1, archived: false } },
  { tbl: 'categories', id: 'cat-coffee', data: { id: 'cat-coffee', name: 'Kafe', key: 'coffee', icon: 'coffee', kind: 'expense', color: '#D9A441', order: 5, archived: false } },
  { tbl: 'categories', id: 'cat-gifts', deleted: true },
  {
    tbl: 'transactions',
    id: 'opening-acc-main',
    data: { id: 'opening-acc-main', kind: 'opening', amount: 255000, currency: 'ALL', rate: 1, mainAmount: 255000, date: 1_758_000_000_000, accountId: 'acc-main', note: '', source: 'manual' },
  },
]

describe('primo accesso su un dispositivo', () => {
  /** Quello che il dispositivo ha inviato al server dopo aver scaricato l'archivio. */
  let pushed: Change[] = []

  beforeEach(async () => {
    pushed = []
    await db.delete()
    await db.open()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { since: number; changes: Change[] }
        pushed.push(...body.changes)
        // Prima richiesta (since 0, niente da inviare): l'archivio completo. Poi nessuna novità.
        const changes = body.since === 0 && body.changes.length === 0 ? ARCHIVE : []
        return new Response(JSON.stringify({ rev: 10 + pushed.length, more: false, changes }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
  })

  afterEach(async () => {
    // Dopo la sincronizzazione partono lavori in sottofondo (scadenze ricorrenti): si aspetta che finiscano prima di chiudere il database.
    await settle()
    vi.unstubAllGlobals()
  })

  it('l’archivio dell’account vince sulle modifiche fatte prima di scaricarlo', async () => {
    // Modifiche fatte guardando i dati predefiniti (valuta stimata, categorie di partenza), finite in coda.
    // Niente movimenti, obiettivi o ricorrenti: con quelli il dispositivo avrebbe dati suoi e si chiederebbe
    // alla persona cosa farne (vedi adoption-sync.test.ts).
    await db.settings.put({ id: 'main', mainCurrency: 'USD', setup: 'later' })
    await db.categories.delete('cat-coffee')
    // Una categoria nuova, invece, esiste solo qui: va caricata.
    await db.categories.put({ id: 'cat-mine', name: 'Mia', icon: 'dots', kind: 'expense', color: '#888888', order: 50, archived: false })
    await settle()
    expect((await db.syncQueue.toArray()).map((q) => q.id).sort()).toEqual(['cat-coffee', 'cat-mine', 'main'])

    const sync = await startSync({ sub: 'user-1' })
    expect(sync?.adopting).toBe(true)
    await sync!.first

    // Sul dispositivo ci sono i dati veri…
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'ALL', setup: 'done' })
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(255000)
    expect((await db.accounts.get('acc-main'))?.currency).toBe('ALL')
    expect((await db.categories.get('cat-coffee'))?.name).toBe('Kafe')
    expect(await db.categories.get('cat-gifts')).toBeUndefined()
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    expect((await db.syncMeta.get('owner'))?.value).toBe('user-1')

    // …e al server non è tornata nessuna delle modifiche fatte sui dati predefiniti.
    const sent = new Map(pushed.map((c) => [`${c.tbl}|${c.id}`, c]))
    expect(sent.has('settings|main')).toBe(false)
    expect(sent.has('transactions|opening-acc-main')).toBe(false)
    expect(sent.has('categories|cat-coffee')).toBe(false)
    expect(sent.has('categories|cat-gifts')).toBe(false)
    expect(pushed.some((c) => c.deleted)).toBe(false)
    // Quello che esiste solo qui parte: la categoria nuova e i dati predefiniti che il server non ha.
    expect(sent.get('categories|cat-mine')?.data?.name).toBe('Mia')
    expect(sent.has('categories|cat-groceries')).toBe(true)
    expect(sent.has('currencies|EUR')).toBe(true)
    expect(await db.syncQueue.count()).toBe(0)
  })

  it('scaricamento interrotto a metà: sul dispositivo non cambia niente finché l’archivio non c’è tutto', async () => {
    let down = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { since: number; changes: Change[] }
        pushed.push(...body.changes)
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
        // Archivio in due pagine: la seconda non arriva finché la rete non torna.
        if (body.since === 0 && body.changes.length === 0) return json({ rev: 3, more: true, changes: ARCHIVE.slice(0, 3) })
        if (body.since === 3 && body.changes.length === 0) {
          if (down) throw new TypeError('network down')
          return json({ rev: 10, more: false, changes: ARCHIVE.slice(3) })
        }
        return json({ rev: 10 + pushed.length, more: false, changes: [] })
      }),
    )
    const sync = await startSync({ sub: 'user-3' })
    await sync!.first
    // La prima pagina (impostazioni e conti in lek) è arrivata, ma non è stata applicata da sola.
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'EUR' })
    expect((await db.accounts.get('acc-main'))?.currency).toBe('EUR')
    expect(await db.transactions.count()).toBe(0)
    expect(await db.syncMeta.get('adopt')).toBeDefined()
    expect(pushed).toEqual([])

    down = false
    await syncNow()
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'ALL', setup: 'done' })
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(255000)
    expect((await db.categories.get('cat-coffee'))?.name).toBe('Kafe')
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    expect((await db.syncMeta.get('rev'))?.value).toBeGreaterThanOrEqual(10)
    expect(pushed.some((c) => c.tbl === 'settings' || c.id === 'opening-acc-main')).toBe(false)
  })

  it('una cancellazione rimasta in coda non cancella sul server un record che c’è ancora', async () => {
    const sync = await startSync({ sub: 'user-4' })
    await sync!.first
    pushed = []
    // Voce di coda superata: dice "cancellato", ma il record è tornato (per esempio dall'archivio).
    await db.syncQueue.put({ tbl: 'categories', id: 'cat-coffee', deleted: true, at: Date.now() })
    await syncNow()
    const sent = pushed.find((c) => c.id === 'cat-coffee')
    expect(sent?.deleted).toBeUndefined()
    expect(sent?.data?.name).toBe('Kafe')
    // Una cancellazione vera, invece, parte.
    await db.categories.delete('cat-groceries')
    await settle()
    await syncNow()
    expect(pushed.find((c) => c.id === 'cat-groceries')?.deleted).toBe(true)
  })

  it('account nuovo: i dati predefiniti del dispositivo diventano l’archivio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { changes: Change[] }
        pushed.push(...body.changes)
        return new Response(JSON.stringify({ rev: pushed.length, more: false, changes: [] }), { status: 200 })
      }),
    )
    const sync = await startSync({ sub: 'user-2' })
    // Stessa sessione del test precedente: la sincronizzazione era già avviata, ma il dispositivo è di nuovo da adottare.
    expect(sync?.adopting).toBe(true)
    await sync!.first
    const sent = new Set(pushed.map((c) => `${c.tbl}|${c.id}`))
    expect(sent.has('settings|main')).toBe(true)
    expect(sent.has('accounts|acc-main')).toBe(true)
    expect(sent.has('accounts|acc-cash')).toBe(true)
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
  })
})
