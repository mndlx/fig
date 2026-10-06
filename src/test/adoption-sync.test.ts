import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../currencyGuess', () => ({ guessCurrency: () => 'EUR' }))

import { isLocalOnly, setLocalOnly } from '../auth'
import { db, SYNCED_TABLES, type Transaction } from '../db'
import { adoptionPending, cancelAdoption, clearLocalData, getSyncStatus, leaveAccount, previewAdoption, resolveAdoption, startSync, syncNow } from '../sync'

interface Change {
  tbl: string
  id: string
  deleted?: boolean
  data?: Record<string, unknown>
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const NOW = Date.now()
const DAY = 86_400_000

const movement = (id: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  kind: 'expense',
  amount,
  currency: 'EUR',
  rate: 1,
  mainAmount: amount,
  date: NOW - DAY,
  accountId: 'acc-main',
  note: '',
  source: 'manual',
  ...extra,
})
const live = (tbl: string, data: object): Change => {
  const row = data as Record<string, unknown>
  return { tbl, id: String(row.id ?? row.code), data: row }
}
const defaultAccount = (id: string, currency: string) => ({ id, name: '', key: id.slice(4), currency, initialBalance: 0, initialMain: 0, order: id === 'acc-main' ? 0 : 1, archived: false })

/** Account in euro che ha già dei dati: impostazioni, conti, un saldo iniziale e un movimento. */
const ACCOUNT: Change[] = [
  live('settings', { id: 'main', mainCurrency: 'EUR', setup: 'done' }),
  live('accounts', defaultAccount('acc-main', 'EUR')),
  live('accounts', defaultAccount('acc-cash', 'EUR')),
  live('categories', { id: 'cat-coffee', name: 'Kafe', key: 'coffee', icon: 'coffee', kind: 'expense', color: '#D9A441', order: 5, archived: false }),
  live('transactions', movement('opening-acc-main', 100000, { kind: 'opening', date: NOW - 30 * DAY })),
  live('transactions', movement('server-1', 2000, { note: 'Spesa' })),
]

/** Server finto: risponde a sincronizzazione, uscita e configurazione; ricorda cosa gli è stato inviato. */
function fakeServer(archive: Change[]) {
  const server = {
    pushed: [] as Change[],
    syncCalls: 0,
    logoutCalls: 0,
    /** Novità arrivate nell'account dopo il primo scaricamento (da un altro dispositivo). */
    delta: [] as Change[],
    syncDown: false,
    logout: 200 as number | 'down',
    localMode: false,
    /** Ordine delle richieste arrivate. */
    order: [] as string[],
  }
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      server.order.push(url === '/api/config' ? 'config' : url === '/auth/logout' ? 'logout' : 'sync')
      if (url === '/api/config') return json({ localMode: server.localMode })
      if (url === '/auth/logout') {
        server.logoutCalls++
        if (server.logout === 'down') throw new TypeError('network down')
        return server.logout === 200 ? json({ url: '/bye' }) : json({ error: 'x' }, server.logout)
      }
      server.syncCalls++
      if (server.syncDown) throw new TypeError('network down')
      const body = JSON.parse(init!.body!) as { since: number; changes: Change[] }
      server.pushed.push(...body.changes)
      if (body.changes.length === 0 && body.since === 0) return json({ rev: 10, more: false, changes: archive })
      if (body.changes.length === 0 && body.since === 10 && server.delta.length > 0) return json({ rev: 20, more: false, changes: server.delta.splice(0) })
      return json({ rev: Math.max(body.since, 10) + body.changes.length, more: false, changes: [] })
    }),
  )
  return server
}

/** Tutto quello che c'è sul dispositivo, per controllare che non sia cambiato niente. */
async function snapshot() {
  const out: Record<string, unknown[]> = {}
  for (const tbl of SYNCED_TABLES) out[tbl] = await db.table(tbl).toArray()
  out.queue = (await db.syncQueue.toArray()).map((q) => `${q.tbl}|${q.id}`)
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown[]>
}

/** Dispositivo usato senza account: dati veri sul dispositivo, niente in coda, nessun proprietario. */
async function usedWithoutAccount(rows: Transaction[] = [movement('local-1', 1250, { note: 'Bar' })]) {
  await db.transactions.bulkPut(rows)
  await settle()
  await db.syncQueue.clear()
}

async function signIn(sub = 'user-1') {
  const sync = await startSync({ sub })
  await sync!.first
  return sync!
}

describe('primo accesso da un dispositivo che ha già dati suoi', () => {
  let reload: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await settle()
    await db.delete()
    await db.open()
    setLocalOnly(false)
    reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload, href: 'http://localhost/' })
  })

  afterEach(async () => {
    await settle()
    vi.unstubAllGlobals()
  })

  it('account senza dati (solo le impostazioni di un altro dispositivo, in un’altra valuta): vince il dispositivo, senza domande', async () => {
    const server = fakeServer([live('settings', { id: 'main', mainCurrency: 'ALL', setup: 'done' }), live('accounts', defaultAccount('acc-main', 'ALL'))])
    await usedWithoutAccount()
    await signIn()
    expect(getSyncStatus().conflict).toBe(false)
    // La valuta resta quella in cui i movimenti sono stati scritti…
    expect((await db.settings.get('main'))?.mainCurrency).toBe('EUR')
    expect((await db.accounts.get('acc-main'))?.currency).toBe('EUR')
    // …e tutto il dispositivo diventa il contenuto dell'account.
    const sent = new Map(server.pushed.map((c) => [`${c.tbl}|${c.id}`, c]))
    expect(sent.get('settings|main')?.data?.mainCurrency).toBe('EUR')
    expect(sent.get('accounts|acc-main')?.data?.currency).toBe('EUR')
    expect(sent.get('transactions|local-1')?.data?.note).toBe('Bar')
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    expect(await db.syncQueue.count()).toBe(0)
  })

  it('dati da tutte e due le parti: non cambia niente, non parte niente, e si aspetta la scelta', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    const before = await snapshot()
    const lastSync = getSyncStatus().lastSync
    await signIn()
    expect(getSyncStatus().conflict).toBe(true)
    // Non risulta "sincronizzato": non è stato scambiato niente.
    expect(getSyncStatus().lastSync).toBe(lastSync)
    expect(await snapshot()).toEqual(before)
    expect(server.pushed).toEqual([])
    expect(await db.syncMeta.get('adopt')).toBeDefined()
    expect(await adoptionPending()).toBe(true)

    // Finché la domanda è aperta i giri successivi non toccano nemmeno la rete.
    const calls = server.syncCalls
    await syncNow()
    await syncNow()
    expect(server.syncCalls).toBe(calls)

    // Quello che si mostra a chi deve scegliere.
    const preview = await previewAdoption()
    expect(preview?.device).toMatchObject({ transactions: 1, openings: 0 })
    expect(preview?.account).toMatchObject({ transactions: 1, openings: 1 })
    expect(preview?.onlyHere).toBe(1)

    // Dopo un ricaricamento della pagina si riscarica e si chiede di nuovo.
    await signIn()
    expect(getSyncStatus().conflict).toBe(true)
    expect(server.syncCalls).toBe(calls + 1)
    expect(await snapshot()).toEqual(before)
  })

  it('“aggiungi al tuo account”: l’account vince per quello che conosce, il resto del dispositivo viene caricato', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount([movement('local-1', 1250, { note: 'Bar' }), movement('opening-acc-main', 255000, { kind: 'opening' })])
    await db.categories.update('cat-coffee', { name: 'Caffè mio' })
    await settle()
    await db.syncQueue.clear()
    await signIn()
    expect(await resolveAdoption('merge')).toBe('merged')

    expect(getSyncStatus().conflict).toBe(false)
    expect(await db.settings.get('main')).toEqual({ id: 'main', mainCurrency: 'EUR', setup: 'done' })
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(100000)
    expect((await db.categories.get('cat-coffee'))?.name).toBe('Kafe')
    expect((await db.transactions.toArray()).map((t) => t.id).sort()).toEqual(['local-1', 'opening-acc-main', 'server-1'])
    // Parte solo quello che l'account non aveva; nessuna cancellazione, niente che sovrascriva un suo record.
    const sent = new Map(server.pushed.map((c) => [`${c.tbl}|${c.id}`, c]))
    expect(sent.get('transactions|local-1')?.data?.note).toBe('Bar')
    for (const key of ['settings|main', 'transactions|opening-acc-main', 'transactions|server-1', 'categories|cat-coffee', 'accounts|acc-main']) expect(sent.has(key)).toBe(false)
    expect(server.pushed.some((c) => c.deleted)).toBe(false)
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    expect(await db.syncQueue.count()).toBe(0)
    expect(getSyncStatus().lastSync).not.toBeNull()
  })

  it('valute diverse: serve il cambio, e al server arrivano i controvalori convertiti su conti separati', async () => {
    const server = fakeServer(ACCOUNT)
    // Dispositivo in lek.
    await db.settings.put({ id: 'main', mainCurrency: 'ALL' })
    await db.accounts.update('acc-main', { currency: 'ALL' })
    await db.accounts.update('acc-cash', { currency: 'ALL' })
    await usedWithoutAccount([movement('local-1', 1500, { currency: 'ALL' }), movement('opening-acc-main', 255000, { kind: 'opening', currency: 'ALL' })])
    await signIn()
    const before = await snapshot()

    // Senza cambio non succede niente.
    await expect(resolveAdoption('merge')).rejects.toThrow('rate_required')
    expect(await snapshot()).toEqual(before)
    expect(getSyncStatus().conflict).toBe(true)
    expect(server.pushed).toEqual([])

    expect(await resolveAdoption('merge', 0.0103)).toBe('merged')
    expect((await db.settings.get('main'))?.mainCurrency).toBe('EUR')
    const sent = server.pushed.filter((c) => c.data)
    const account = sent.find((c) => c.tbl === 'accounts')!
    expect(account.data).toMatchObject({ name: 'Current account (ALL)', currency: 'ALL' })
    expect(sent.find((c) => c.id === 'local-1')?.data).toMatchObject({ currency: 'ALL', amount: 1500, mainAmount: 1545, rate: 0.0103, accountId: account.id })
    expect(sent.find((c) => c.id === `opening-${account.id}`)?.data).toMatchObject({ amount: 255000, mainAmount: 262650, accountId: account.id })
    // Il conto e il saldo iniziale dell'account restano i suoi.
    expect((await db.accounts.get('acc-main'))?.currency).toBe('EUR')
    expect((await db.transactions.get('opening-acc-main'))?.amount).toBe(100000)
    expect(server.pushed.some((c) => ['acc-main', 'opening-acc-main', 'main'].includes(c.id))).toBe(false)
  })

  it('quello che è arrivato nell’account mentre si decideva vince come il resto', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount([movement('local-1', 1250), movement('opening-acc-cash', 7000, { kind: 'opening', accountId: 'acc-cash' })])
    await signIn()
    // Intanto, da un altro dispositivo, l'account riceve un saldo iniziale per lo stesso conto.
    server.delta = [live('transactions', movement('opening-acc-cash', 9000, { kind: 'opening', accountId: 'acc-cash' }))]
    await resolveAdoption('merge')
    expect((await db.transactions.get('opening-acc-cash'))?.amount).toBe(9000)
    expect(server.pushed.some((c) => c.id === 'opening-acc-cash')).toBe(false)
    expect(server.pushed.some((c) => c.id === 'local-1')).toBe(true)
  })

  it('senza rete al momento della scelta: errore, e non è cambiato niente', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    const before = await snapshot()
    server.syncDown = true
    await expect(resolveAdoption('merge')).rejects.toThrow()
    await expect(resolveAdoption('account')).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
    expect(getSyncStatus().conflict).toBe(true)
    expect(server.pushed).toEqual([])
    expect(await db.syncMeta.get('adopt')).toBeDefined()
  })

  it('“tieni solo i dati del tuo account”: il dispositivo si svuota e riparte come uno nuovo', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    const calls = server.syncCalls
    expect(await resolveAdoption('account')).toBe('dropped')
    // Prima di cancellare si è verificato che rete e sessione ci fossero.
    expect(server.syncCalls).toBe(calls + 1)
    expect(server.pushed).toEqual([])

    // La pagina si ricarica: database nuovo, accesso, e arrivano i dati dell'account.
    await db.open()
    expect(await db.transactions.count()).toBe(0)
    await signIn()
    expect(getSyncStatus().conflict).toBe(false)
    expect((await db.transactions.toArray()).map((t) => t.id).sort()).toEqual(['opening-acc-main', 'server-1'])
    expect((await db.categories.get('cat-coffee'))?.name).toBe('Kafe')
    expect(server.pushed.some((c) => c.id === 'local-1' || c.deleted)).toBe(false)
  })

  it('uscire senza scegliere: i dati restano sul dispositivo, scollegato dall’account', async () => {
    const server = fakeServer(ACCOUNT)
    server.localMode = true
    await usedWithoutAccount()
    await signIn()
    const rows = (await snapshot()).transactions

    // Se la sessione non si chiude (senza rete, o errore del server) non cambia niente e la domanda resta.
    for (const failure of ['down', 500] as const) {
      server.logout = failure
      await expect(cancelAdoption()).rejects.toThrow()
      expect((await db.syncMeta.get('owner'))?.value).toBe('user-1')
      expect(await db.syncMeta.get('adopt')).toBeDefined()
      expect(getSyncStatus().conflict).toBe(true)
      expect(isLocalOnly()).toBe(false)
    }

    server.logout = 200
    expect(await cancelAdoption()).toBe('/bye')
    expect(await db.syncMeta.toArray()).toEqual([])
    expect(await db.syncQueue.count()).toBe(0)
    expect((await snapshot()).transactions).toEqual(rows)
    expect(getSyncStatus().conflict).toBe(false)
    // Si continua senza account solo perché il server lo permette.
    expect(isLocalOnly()).toBe(true)
    // Da qui in poi questa pagina non sincronizza più niente, nemmeno le modifiche fatte dopo.
    const calls = server.syncCalls
    await db.transactions.put(movement('after', 100))
    await settle()
    await syncNow()
    expect(server.syncCalls).toBe(calls)
    expect(await db.syncQueue.count()).toBe(0)
    expect(server.pushed).toEqual([])
  })

  it('uscire dove l’uso senza account è spento: stessi dati al sicuro, ma al prossimo avvio servirà l’accesso', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    expect(await cancelAdoption()).toBe('/bye')
    expect(isLocalOnly()).toBe(false)
    expect(await db.transactions.get('local-1')).toBeDefined()
    expect(server.pushed).toEqual([])
  })

  it('domanda già risolta da un’altra finestra: nessuna scrittura, si riprende normalmente', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    // Un'altra finestra ha concluso l'adozione (ha applicato la scelta e segnato fin dove è arrivata).
    await db.syncMeta.put({ key: 'rev', value: 10 })
    await db.syncMeta.delete('adopt')
    const before = await snapshot()
    expect(await resolveAdoption('merge')).toBe('gone')
    expect(await snapshot()).toEqual(before)
    expect(getSyncStatus().conflict).toBe(false)
    expect(await cancelAdoption()).toBeNull()
    expect(server.logoutCalls).toBe(0)
    expect((await db.syncMeta.get('owner'))?.value).toBe('user-1')
  })

  it('accesso con un altro account prima di aver scelto: i dati mai caricati non vengono cancellati', async () => {
    fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn('user-1')
    expect(getSyncStatus().conflict).toBe(true)
    // La persona esce (o la sessione scade) e rientra con un altro account, che è vuoto.
    const server = fakeServer([])
    await signIn('user-2')
    expect(reload).not.toHaveBeenCalled()
    expect((await db.syncMeta.get('owner'))?.value).toBe('user-2')
    expect(await db.transactions.get('local-1')).toBeDefined()
    // Per il nuovo account è un dispositivo coi suoi dati e un account vuoto: vengono caricati.
    expect(getSyncStatus().conflict).toBe(false)
    expect(server.pushed.some((c) => c.id === 'local-1')).toBe(true)
  })

  it('dispositivo che era la copia sincronizzata di un altro account: si cancella, come prima', async () => {
    fakeServer([])
    await signIn('user-1')
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    fakeServer(ACCOUNT)
    expect(await startSync({ sub: 'user-2' })).toBeNull()
    expect(reload).toHaveBeenCalled()
    await db.open()
    expect(await db.syncMeta.get('owner')).toBeUndefined()
  })

  it('il dispositivo non è più di questo utente (un’altra finestra è uscita): niente rete, si riparte dall’avvio', async () => {
    const server = fakeServer([])
    await signIn('user-1')
    const calls = server.syncCalls
    await db.syncMeta.delete('owner')
    await syncNow()
    expect(server.syncCalls).toBe(calls)
    expect(reload).toHaveBeenCalled()
  })

  it('senza un accesso fatto da questa pagina non si sincronizza mai', async () => {
    const server = fakeServer(ACCOUNT)
    await clearLocalData()
    await db.open()
    await usedWithoutAccount()
    await syncNow()
    expect(server.syncCalls).toBe(0)
  })

  it('“Esci” dalle Impostazioni con dati mai caricati: il dispositivo si scollega e i dati restano, anche toccando due volte', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    const left = await leaveAccount()
    expect(left).toEqual({ outcome: 'kept', url: '/bye' })
    expect(await db.syncMeta.toArray()).toEqual([])
    expect(await db.transactions.get('local-1')).toBeDefined()
    // Secondo tocco mentre la pagina sta ancora andando via (o da un'altra finestra): il dispositivo è già
    // scollegato, quello che c'è è solo suo e non si cancella.
    expect(await leaveAccount()).toEqual({ outcome: 'unlinked' })
    expect(await leaveAccount(true)).toEqual({ outcome: 'unlinked' })
    expect(await db.transactions.get('local-1')).toBeDefined()
    expect(server.pushed).toEqual([])
  })

  it('“Esci” mentre il primo scaricamento non era ancora riuscito: non fa partire proprio adesso il caricamento', async () => {
    // Account vuoto: se uscendo si sincronizzasse, i dati di qui verrebbero caricati e poi cancellati dal dispositivo.
    const server = fakeServer([])
    server.syncDown = true
    await usedWithoutAccount()
    await signIn()
    expect(await adoptionPending()).toBe(true)
    server.syncDown = false
    expect(await leaveAccount()).toEqual({ outcome: 'kept', url: '/bye' })
    expect(server.pushed).toEqual([])
    expect(await db.transactions.get('local-1')).toBeDefined()
    // La richiesta "si può continuare senza account?" parte prima di chiudere la sessione, non dopo.
    expect(server.order.filter((step) => step !== 'sync')).toEqual(['config', 'logout'])
  })

  it('“Esci” quando la sessione non si chiude, o da una pagina che non ha fatto l’accesso: errore e niente cambia', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    server.logout = 'down'
    await expect(leaveAccount()).rejects.toThrow()
    expect((await db.syncMeta.get('owner'))?.value).toBe('user-1')
    expect(await db.transactions.get('local-1')).toBeDefined()
    // Pagina partita senza rete su un dispositivo già legato: non ha fatto l'accesso, quindi non può scollegarlo.
    await clearLocalData()
    await db.open()
    await usedWithoutAccount()
    await db.syncMeta.bulkPut([
      { key: 'owner', value: 'user-1' },
      { key: 'adopt', value: 1 },
    ])
    server.logout = 200
    await expect(leaveAccount()).rejects.toThrow('cannot_leave')
    expect(server.logoutCalls).toBe(1)
    expect(await db.syncMeta.get('adopt')).toBeDefined()
    expect(await db.transactions.get('local-1')).toBeDefined()
  })

  it('“Esci” da un dispositivo sincronizzato: come prima, conferma se c’è qualcosa non ancora inviato, poi i dati locali si cancellano', async () => {
    const server = fakeServer(ACCOUNT)
    await signIn()
    expect(await db.transactions.count()).toBe(2)
    // Una modifica che non riesce a partire.
    server.syncDown = true
    await db.transactions.put(movement('unsent', 100))
    await settle()
    expect(await leaveAccount()).toEqual({ outcome: 'confirm', waiting: 1 })
    expect(await db.transactions.count()).toBe(3)
    expect(await leaveAccount(true)).toEqual({ outcome: 'cleared' })
    await db.open()
    expect(await db.transactions.count()).toBe(0)
  })

  it('una cancellazione fatta prima del primo scaricamento arriva comunque al server', async () => {
    // Account nuovo; sul dispositivo si toglie una categoria predefinita mentre il primo giro non è ancora riuscito.
    const server = fakeServer([])
    server.syncDown = true
    await signIn()
    await db.categories.delete('cat-coffee')
    await settle()
    server.syncDown = false
    await syncNow()
    expect(server.pushed.find((c) => c.id === 'cat-coffee')?.deleted).toBe(true)
    expect(server.pushed.some((c) => c.id === 'cat-groceries' && c.data)).toBe(true)
    expect(await db.syncQueue.count()).toBe(0)
  })

  it('domanda aperta, poi sul dispositivo non resta niente di suo: la domanda non vale più e arrivano i dati dell’account', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    expect(getSyncStatus().conflict).toBe(true)
    await db.transactions.delete('local-1')
    await settle()
    await syncNow()
    expect(getSyncStatus().conflict).toBe(false)
    expect(await db.syncMeta.get('adopt')).toBeUndefined()
    expect((await db.transactions.toArray()).map((t) => t.id).sort()).toEqual(['opening-acc-main', 'server-1'])
    expect(server.pushed.some((c) => c.id === 'server-1' || c.id === 'opening-acc-main')).toBe(false)
  })

  it('dopo un’uscita, un nuovo accesso dalla stessa pagina rimette in coda le modifiche', async () => {
    const server = fakeServer(ACCOUNT)
    await usedWithoutAccount()
    await signIn()
    await cancelAdoption()
    // Accesso con un account vuoto: i dati vengono caricati, e una modifica successiva parte anche lei.
    const empty = fakeServer([])
    await signIn('user-9')
    await db.transactions.put(movement('later', 700))
    await settle()
    await syncNow()
    expect(empty.pushed.some((c) => c.id === 'later')).toBe(true)
    expect(server.pushed).toEqual([])
  })

  it('saldo iniziale nel vecchio campo del conto: conta come dato del dispositivo', async () => {
    fakeServer(ACCOUNT)
    await db.accounts.update('acc-cash', { initialBalance: 7000, initialMain: 7000 })
    await settle()
    await db.syncQueue.clear()
    await signIn()
    // Prima di decidere è diventato un movimento "saldo iniziale"; e siccome anche l'account ha dati, si chiede.
    expect((await db.transactions.get('opening-acc-cash'))?.amount).toBe(7000)
    expect(getSyncStatus().conflict).toBe(true)
  })
})
