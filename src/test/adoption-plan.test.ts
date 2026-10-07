import { describe, expect, it } from 'vitest'
import {
  ADOPT_TABLES,
  archiveKey,
  classifyAdoption,
  describeAdoption,
  planAdoption,
  reduceArchive,
  rowKey,
  toAccountMain,
  type AdoptionPlan,
  type LocalData,
  type MergeOptions,
  type RemoteChange,
  type Row,
} from '../adoption'
import { accountBalanceOf } from '../data'
import { SYNCED_TABLES, type Account, type SyncedTable, type Transaction } from '../db'

const DAY = 86_400_000
const NOW = new Date(2026, 9, 5, 12).getTime()

const EUR = { code: 'EUR', symbol: '€', decimals: 2 }
const USD = { code: 'USD', symbol: '$', decimals: 2 }
const ALL = { code: 'ALL', symbol: 'L', decimals: 0 }

const acc = (id: string, currency: string, extra: Row = {}): Row => ({
  id,
  name: '',
  ...(id === 'acc-main' ? { key: 'main' } : id === 'acc-cash' ? { key: 'cash' } : {}),
  currency,
  initialBalance: 0,
  initialMain: 0,
  order: id === 'acc-main' ? 0 : 1,
  archived: false,
  ...extra,
})
const cat = (id: string, extra: Row = {}): Row => ({ id, name: '', key: id.slice(4), icon: 'dots', kind: 'expense', color: '#888', order: 0, archived: false, ...extra })
const tx = (id: string, kind: string, amount: number, extra: Row = {}): Row => ({
  id,
  kind,
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
const opening = (account: string, amount: number, extra: Row = {}) => tx(`opening-${account}`, 'opening', amount, { accountId: account, date: NOW - 30 * DAY, ...extra })

/** Dispositivo coi dati predefiniti in euro, più quello che si aggiunge. */
function device(parts: Partial<LocalData> = {}): LocalData {
  return {
    settings: [{ id: 'main', mainCurrency: 'EUR' }],
    currencies: [EUR, USD, ALL],
    accounts: [acc('acc-main', 'EUR'), acc('acc-cash', 'EUR')],
    categories: [cat('cat-groceries'), cat('cat-gifts')],
    goals: [],
    transactions: [],
    rules: [],
    importProfiles: [],
    recurring: [],
    ...parts,
  }
}
/** Lo stesso, ma in lek. */
const lekDevice = (parts: Partial<LocalData> = {}) =>
  device({ settings: [{ id: 'main', mainCurrency: 'ALL' }], accounts: [acc('acc-main', 'ALL'), acc('acc-cash', 'ALL')], ...parts })

const live = (tbl: SyncedTable, row: Row): RemoteChange => ({ tbl, id: rowKey(tbl, row), data: row })
const dead = (tbl: SyncedTable, id: string): RemoteChange => ({ tbl, id, deleted: true })
/** Account in euro con le impostazioni e i conti predefiniti, più quello che si aggiunge. */
const account = (...more: RemoteChange[]) =>
  reduceArchive([
    live('settings', { id: 'main', mainCurrency: 'EUR', setup: 'done' }),
    ...[EUR, USD, ALL].map((c) => live('currencies', c)),
    live('accounts', acc('acc-main', 'EUR')),
    live('accounts', acc('acc-cash', 'EUR')),
    live('categories', cat('cat-groceries')),
    live('categories', cat('cat-gifts')),
    ...more,
  ])

function options(rate?: number): MergeOptions {
  let n = 0
  return { rate, newId: () => `new-${++n}`, accountName: (a) => String(a.name) || (a.key === 'main' ? 'Conto' : a.key === 'cash' ? 'Contanti' : '?') }
}

/** Il dispositivo dopo aver applicato un piano, come farebbe sync.ts. */
function apply(local: LocalData, plan: AdoptionPlan): LocalData {
  const out = {} as LocalData
  for (const tbl of ADOPT_TABLES) {
    const rows = new Map((local[tbl] ?? []).map((row) => [rowKey(tbl, row), row]))
    for (const r of plan.remove) if (r.tbl === tbl) rows.delete(r.id)
    for (const p of plan.put) if (p.tbl === tbl) rows.set(rowKey(tbl, p.row), p.row)
    out[tbl] = [...rows.values()]
  }
  return out
}
const queued = (plan: AdoptionPlan) => plan.queue.map((q) => archiveKey(q.tbl, q.id)).sort()

/** Congela un valore in profondità: un piano che modificasse i dati che riceve farebbe fallire il test. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of value instanceof Map ? value.values() : Object.values(value as object)) frozen(inner)
  }
  return value
}

/**
 * Unione con i controlli che devono valere sempre: i dati in ingresso non vengono toccati; niente di quello che
 * parte esiste già nell'account; tutto quello che resta sul dispositivo e l'account non ha viene caricato;
 * niente viene insieme tolto e scritto o caricato.
 */
function merge(local: LocalData, archive: ReturnType<typeof account>, opts: MergeOptions): { plan: AdoptionPlan; after: LocalData } {
  const plan = planAdoption('merge', frozen(local), frozen(archive), opts)
  const after = apply(local, plan)
  const has = (tbl: SyncedTable, key: string) => after[tbl].some((row) => archiveKey(tbl, rowKey(tbl, row)) === key)
  const inQueue = new Set(queued(plan))
  const removed = new Set(plan.remove.map((r) => archiveKey(r.tbl, r.id)))
  for (const key of inQueue) {
    expect(archive.get(key)?.deleted === false || (archive.get(key)?.data !== undefined && !archive.get(key)?.deleted), `${key} è già nell'account`).toBe(false)
    expect(removed.has(key), `${key} tolto e caricato`).toBe(false)
  }
  for (const p of plan.put) expect(removed.has(archiveKey(p.tbl, rowKey(p.tbl, p.row))), 'tolto e scritto').toBe(false)
  // Quello che va in coda deve esistere (una voce senza record partirebbe come cancellazione)…
  for (const q of plan.queue) expect(has(q.tbl, archiveKey(q.tbl, q.id)), `${q.tbl}|${q.id} in coda ma non esiste`).toBe(true)
  // …e i record dell'account restano identici a come sono nell'account.
  for (const [key, c] of archive) if (!c.deleted && c.data) expect(after[c.tbl].find((row) => archiveKey(c.tbl, rowKey(c.tbl, row)) === key), `${key} non è più quello dell'account`).toEqual(c.data)
  for (const tbl of ADOPT_TABLES) {
    for (const row of after[tbl]) {
      const key = archiveKey(tbl, rowKey(tbl, row))
      const there = archive.get(key)
      if (!there || there.deleted || !there.data) expect(inQueue.has(key), `${key} resta qui ma non viene caricato`).toBe(true)
    }
  }
  return { plan, after }
}
const balance = (data: LocalData, accountId: string, main: string) =>
  accountBalanceOf(data.accounts.find((a) => a.id === accountId) as unknown as Account, data.transactions as unknown as Transaction[], main, NOW)

describe('dati dell’account scaricati', () => {
  it('le tabelle sono le stesse della sincronizzazione', () => {
    expect([...ADOPT_TABLES].sort()).toEqual([...SYNCED_TABLES].sort())
  })

  it('di un record cambiato durante lo scaricamento vale l’ultima versione', () => {
    const a = reduceArchive([live('transactions', tx('t1', 'expense', 100)), dead('transactions', 't1'), dead('goals', 'g1'), live('goals', { id: 'g1', name: 'Vacanza' })])
    expect(a.get('transactions|t1')?.deleted).toBe(true)
    expect(a.get('goals|g1')?.data?.name).toBe('Vacanza')
    // Una seconda scaricata (le novità arrivate nel frattempo) si aggiunge alla prima.
    reduceArchive([live('transactions', tx('t1', 'expense', 250))], a)
    expect(a.get('transactions|t1')?.data?.amount).toBe(250)
  })
})

describe('serve una scelta?', () => {
  it('dispositivo senza dati della persona: vince l’account', () => {
    expect(classifyAdoption(device(), account(live('transactions', tx('s1', 'expense', 100))))).toBe('server')
  })

  it('account senza dati della persona: vince il dispositivo, anche se ha impostazioni in un’altra valuta', () => {
    const lekAccount = reduceArchive([live('settings', { id: 'main', mainCurrency: 'ALL', setup: 'done' }), live('accounts', acc('acc-main', 'ALL')), live('categories', cat('cat-x'))])
    expect(classifyAdoption(device({ transactions: [tx('d1', 'expense', 100)] }), lekAccount)).toBe('device')
    // Anche quando nell'account restano solo le tracce di dati cancellati.
    expect(classifyAdoption(device({ goals: [{ id: 'g1', name: 'Vacanza', target: 1000 }] }), account(dead('transactions', 'gone'), dead('goals', 'old')))).toBe('device')
  })

  it('un saldo iniziale nel vecchio campo del conto conta come dato dell’account', () => {
    const old = reduceArchive([live('accounts', acc('acc-main', 'EUR', { initialBalance: 50000, initialMain: 50000 }))])
    expect(classifyAdoption(device({ transactions: [tx('d1', 'expense', 100)] }), old)).toBe('conflict')
  })

  it('dati da tutte e due le parti: si chiede, anche solo per un saldo iniziale diverso', () => {
    const there = account(live('transactions', tx('s1', 'expense', 100)), live('transactions', opening('acc-main', 100000)))
    expect(classifyAdoption(device({ transactions: [tx('d1', 'expense', 100)] }), there)).toBe('conflict')
    expect(classifyAdoption(device({ transactions: [opening('acc-main', 255000)] }), there)).toBe('conflict')
  })

  it('dispositivo che è una copia identica dell’account (ripristinato da un backup): niente da chiedere', () => {
    const rows = [tx('s1', 'expense', 100, { categoryId: undefined }), opening('acc-main', 100000)]
    // Stessi record, campi in un altro ordine e senza quelli vuoti (come arrivano dal server).
    const there = account(...rows.map((row) => live('transactions', Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(row)) as Row).reverse()))))
    expect(classifyAdoption(device({ transactions: rows }), there)).toBe('server')
    // Basta un record modificato, o cancellato nell'account, perché ci sia qualcosa da perdere.
    expect(classifyAdoption(device({ transactions: [{ ...rows[0], amount: 999 }, rows[1]] }), there)).toBe('conflict')
    expect(classifyAdoption(device({ transactions: rows }), reduceArchive([dead('transactions', 's1')], there))).toBe('conflict')
  })
})

describe('senza domande', () => {
  it('vince l’account: i suoi record si scrivono, i cancellati se ne vanno, quello che esiste solo qui viene caricato', () => {
    const local = device({ categories: [cat('cat-groceries'), cat('cat-gifts'), cat('cat-mine', { name: 'Mia' })] })
    const there = account(live('settings', { id: 'main', mainCurrency: 'ALL', setup: 'done' }), dead('categories', 'cat-gifts'), live('transactions', tx('s1', 'expense', 100)))
    const plan = planAdoption('server', local, there)
    const after = apply(local, plan)
    expect(after.settings).toEqual([{ id: 'main', mainCurrency: 'ALL', setup: 'done' }])
    expect(after.categories.map((c) => c.id).sort()).toEqual(['cat-groceries', 'cat-mine'])
    expect(after.transactions.map((t) => t.id)).toEqual(['s1'])
    expect(queued(plan)).toEqual(['categories|cat-mine'])
  })

  it('vince il dispositivo: dell’account arriva solo quello che qui manca, e tutto quello che è qui viene caricato', () => {
    const local = lekDevice({ transactions: [tx('d1', 'expense', 1500, { currency: 'ALL' })] })
    const there = reduceArchive([
      live('settings', { id: 'main', mainCurrency: 'EUR' }),
      live('accounts', acc('acc-main', 'EUR')),
      live('categories', cat('cat-other', { name: 'Altro dispositivo' })),
      dead('categories', 'cat-gifts'),
    ])
    const plan = planAdoption('device', local, there)
    const after = apply(local, plan)
    expect(after.settings).toEqual([{ id: 'main', mainCurrency: 'ALL' }])
    expect(after.accounts.find((a) => a.id === 'acc-main')?.currency).toBe('ALL')
    expect(after.categories.map((c) => c.id).sort()).toEqual(['cat-gifts', 'cat-groceries', 'cat-other'])
    expect(after.transactions[0]).toEqual(local.transactions[0])
    expect(plan.remove).toEqual([])
    // In coda tutto quello che c'era qui, non quello appena arrivato.
    expect(queued(plan)).toContain('settings|main')
    expect(queued(plan)).toContain('transactions|d1')
    expect(queued(plan)).toContain('categories|cat-gifts')
    expect(queued(plan)).not.toContain('categories|cat-other')
  })
})

describe('unione, stessa valuta', () => {
  const there = account(
    live('settings', { id: 'main', mainCurrency: 'EUR', setup: 'done' }),
    live('transactions', opening('acc-main', 100000)),
    live('transactions', tx('s1', 'expense', 2000)),
    live('categories', cat('cat-groceries', { name: 'Supermercato' })),
  )

  it('l’account vince per quello che conosce; il resto del dispositivo resta com’è e viene caricato', () => {
    const local = device({
      settings: [{ id: 'main', mainCurrency: 'EUR', setup: 'later' }],
      transactions: [opening('acc-main', 255000), tx('d1', 'expense', 1250, { categoryId: 'cat-groceries' }), tx('d2', 'save', 5000, { goalId: 'g1' })],
      goals: [{ id: 'g1', name: 'Vacanza', target: 100000, color: '#000', order: 0, archived: false }],
      rules: [{ id: 'r1', match: 'bar', categoryId: 'cat-groceries' }],
    })
    const plan = planAdoption('merge', local, there, options())
    const after = apply(local, plan)
    expect(after.settings).toEqual([{ id: 'main', mainCurrency: 'EUR', setup: 'done' }])
    expect(after.transactions.find((t) => t.id === 'opening-acc-main')?.amount).toBe(100000)
    expect(after.categories.find((c) => c.id === 'cat-groceries')?.name).toBe('Supermercato')
    expect(after.transactions.map((t) => t.id).sort()).toEqual(['d1', 'd2', 'opening-acc-main', 's1'])
    // I record di qui non vengono nemmeno riscritti.
    expect(plan.put.some((p) => ['d1', 'd2', 'g1', 'r1'].includes(rowKey(p.tbl, p.row)))).toBe(false)
    expect(queued(plan)).toEqual(['goals|g1', 'rules|r1', 'transactions|d1', 'transactions|d2'])
    // Il saldo iniziale di qui viene sostituito: lo si dice a chi sceglie.
    const preview = describeAdoption(local, there, options(), NOW)
    expect(preview.droppedOpenings).toEqual([{ accountId: 'acc-main', name: 'Conto', currency: 'EUR', here: 255000, there: 100000 }])
    expect(preview.onlyHere).toBe(3)
    expect(preview.rekeyed).toEqual([])
  })

  it('un saldo iniziale di qui resta se l’account non ne ha uno, o lo ha cancellato', () => {
    const local = device({ transactions: [opening('acc-cash', 7000, { accountId: 'acc-cash' }), tx('d1', 'expense', 500, { accountId: 'acc-cash' })] })
    for (const archive of [there, reduceArchive([dead('transactions', 'opening-acc-cash')], new Map(there))]) {
      const plan = planAdoption('merge', local, archive, options())
      expect(apply(local, plan).transactions.find((t) => t.id === 'opening-acc-cash')?.amount).toBe(7000)
      expect(queued(plan)).toEqual(['transactions|d1', 'transactions|opening-acc-cash'])
      expect(describeAdoption(local, archive, options(), NOW).droppedOpenings).toEqual([])
    }
  })

  it('quello che l’account ha cancellato ma i dati di qui usano ancora resta, e torna nell’account', () => {
    const local = device({
      currencies: [EUR, USD, ALL],
      accounts: [acc('acc-main', 'EUR'), acc('acc-cash', 'EUR'), acc('acc-old', 'ALL', { name: 'Vecchio' })],
      categories: [cat('cat-groceries'), cat('cat-gifts'), cat('cat-unused')],
      goals: [{ id: 'g1', name: 'Vacanza', target: 1000 }, { id: 'g2', name: 'Altro', target: 0 }],
      transactions: [
        tx('d1', 'expense', 500, { accountId: 'acc-cash', categoryId: 'cat-gifts' }),
        tx('d2', 'save', 300, { goalId: 'g1' }),
        tx('d3', 'expense', 9000, { accountId: 'acc-old', currency: 'ALL', rate: 0.01, mainAmount: 90 }),
        opening('acc-cash', 7000),
        tx('gone', 'expense', 100),
      ],
    })
    const archive = reduceArchive(
      [
        dead('currencies', 'ALL'),
        dead('accounts', 'acc-cash'),
        dead('transactions', 'opening-acc-cash'),
        dead('accounts', 'acc-old'),
        dead('categories', 'cat-gifts'),
        dead('categories', 'cat-unused'),
        dead('goals', 'g1'),
        dead('goals', 'g2'),
        dead('transactions', 'gone'),
      ],
      new Map(there),
    )
    const plan = planAdoption('merge', local, archive, options())
    const after = apply(local, plan)
    // Usati dai movimenti di qui: restano (il conto vecchio tiene in vita anche la sua valuta).
    expect(after.accounts.map((a) => a.id).sort()).toEqual(['acc-cash', 'acc-main', 'acc-old'])
    expect(after.currencies.map((c) => c.code).sort()).toEqual(['ALL', 'EUR', 'USD'])
    expect(after.categories.map((c) => c.id).sort()).toEqual(['cat-gifts', 'cat-groceries'])
    expect(after.goals.map((g) => g.id)).toEqual(['g1'])
    expect(after.transactions.map((t) => t.id).sort()).toEqual(['d1', 'd2', 'd3', 'opening-acc-cash', 'opening-acc-main', 's1'])
    // E vengono ricaricati nell'account insieme ai movimenti.
    for (const key of ['accounts|acc-cash', 'accounts|acc-old', 'currencies|ALL', 'categories|cat-gifts', 'goals|g1', 'transactions|opening-acc-cash']) expect(queued(plan)).toContain(key)
    // Quello che nessuno usa se ne va come vuole l'account.
    expect(queued(plan)).not.toContain('categories|cat-unused')
    expect(queued(plan)).not.toContain('goals|g2')
    expect(queued(plan)).not.toContain('transactions|gone')
  })

  it('conto e saldo iniziale cancellati nell’account, ma qui quel conto ha dei soldi: restano, e tornano nell’account', () => {
    // Nell'account "Contanti" è stato eliminato (col suo saldo iniziale); qui ha 70 € di partenza e nessun movimento.
    const archive = reduceArchive([dead('accounts', 'acc-cash'), dead('transactions', 'opening-acc-cash')], new Map(there))
    const local = device({ transactions: [opening('acc-cash', 7000, { accountId: 'acc-cash' }), tx('d1', 'expense', 500)] })
    const { plan, after } = merge(local, archive, options())
    expect(plan.remove).toEqual([])
    expect(after.accounts.map((a) => a.id).sort()).toEqual(['acc-cash', 'acc-main'])
    expect(balance(after, 'acc-cash', 'EUR')).toBe(7000)
    expect(queued(plan)).toEqual(['accounts|acc-cash', 'transactions|d1', 'transactions|opening-acc-cash'])
    // Senza soldi su quel conto (nessun saldo iniziale, o a zero), invece, se ne va come vuole l'account.
    const empty = device({ transactions: [tx('d1', 'expense', 500)] })
    expect(apply(empty, planAdoption('merge', empty, archive, options())).accounts.map((a) => a.id)).toEqual(['acc-main'])
    const zero = device({ transactions: [opening('acc-cash', 0, { accountId: 'acc-cash' }), tx('d1', 'expense', 500)] })
    const zeroPlan = merge(zero, archive, options()).plan
    expect(zeroPlan.remove).toEqual([
      { tbl: 'accounts', id: 'acc-cash' },
      { tbl: 'transactions', id: 'opening-acc-cash' },
    ])
  })

  it('conto dell’account col saldo iniziale ancora nel vecchio campo: resta il suo, quello di qui viene sostituito e lo si dice', () => {
    const archive = account(live('accounts', acc('acc-main', 'EUR', { initialBalance: 50000, initialMain: 50000 })), live('transactions', tx('s1', 'expense', 100)))
    const local = device({ transactions: [opening('acc-main', 7000), tx('d1', 'expense', 500)] })
    const { plan, after } = merge(local, archive, options())
    expect(plan.remove).toEqual([{ tbl: 'transactions', id: 'opening-acc-main' }])
    expect(after.accounts.find((a) => a.id === 'acc-main')?.initialBalance).toBe(50000)
    expect(queued(plan)).toEqual(['transactions|d1'])
    expect(describeAdoption(local, archive, options(), NOW).droppedOpenings).toEqual([{ accountId: 'acc-main', name: 'Conto', currency: 'EUR', here: 7000, there: 50000 }])
    // Lo stesso anche se nell'account risulta la traccia di un vecchio saldo iniziale cancellato.
    const withTrace = reduceArchive([dead('transactions', 'opening-acc-main')], new Map(archive))
    const again = merge(local, withTrace, options()).plan
    expect(again.remove).toEqual([{ tbl: 'transactions', id: 'opening-acc-main' }])
    expect(queued(again)).toEqual(['transactions|d1'])
  })

  it('niente di quello che viene caricato esiste già nell’account', () => {
    const local = device({ transactions: [opening('acc-main', 255000), tx('d1', 'expense', 1250), tx('s1', 'expense', 9999)] })
    const plan = planAdoption('merge', local, there, options())
    for (const q of plan.queue) expect(there.get(archiveKey(q.tbl, q.id))?.data).toBeUndefined()
    // Il movimento con lo stesso id di uno dell'account non viene toccato dal dispositivo.
    expect(apply(local, plan).transactions.find((t) => t.id === 's1')?.amount).toBe(2000)
  })
})

describe('unione: conti con lo stesso id e un’altra valuta', () => {
  it('quello del dispositivo diventa un conto separato, coi suoi movimenti e il suo saldo iniziale', () => {
    // Stessa valuta principale (euro) da tutte e due le parti, ma "Contanti" nell'account è in dollari.
    const there = account(live('accounts', acc('acc-cash', 'USD')), live('transactions', opening('acc-cash', 20000, { currency: 'USD', rate: 0.9, mainAmount: 18000 })), live('transactions', tx('s1', 'expense', 100)))
    const local = device({
      transactions: [opening('acc-cash', 7000), tx('d1', 'expense', 500, { accountId: 'acc-cash' }), tx('d2', 'transfer', 2000, { accountId: 'acc-main', toAccountId: 'acc-cash' })],
      recurring: [{ id: 'r1', kind: 'expense', amount: 1000, currency: 'EUR', rate: 1, mainAmount: 1000, categoryId: 'cat-gifts', accountId: 'acc-cash', note: '', frequency: 'month', start: NOW, next: NOW, active: true }],
      importProfiles: [{ id: 'p1', name: 'Banca', signature: 'a|b', dateCol: 0, descCol: 1, amountCol: 2, creditCol: -1, accountId: 'acc-cash' }],
    })
    const before = balance(local, 'acc-cash', 'EUR')
    const { plan, after } = merge(local, there, options())
    // Il vecchio saldo iniziale (in euro) non resta attaccato al conto dell'account: lo sostituisce il suo.
    expect(plan.remove).toEqual([])
    const fresh = after.accounts.find((a) => a.id === 'new-1')!
    expect(fresh).toMatchObject({ name: 'Contanti (EUR)', currency: 'EUR', order: 2 })
    expect(fresh.key).toBeUndefined()
    // Il conto dell'account resta com'è, col suo saldo iniziale in dollari.
    expect(after.accounts.find((a) => a.id === 'acc-cash')?.currency).toBe('USD')
    expect(after.transactions.find((t) => t.id === 'opening-acc-cash')).toMatchObject({ currency: 'USD', amount: 20000 })
    // Movimenti, ricorrenti e profili di importazione seguono il conto nuovo; il conto principale no.
    expect(after.transactions.find((t) => t.id === 'opening-new-1')).toMatchObject({ accountId: 'new-1', amount: 7000, currency: 'EUR' })
    expect(after.transactions.find((t) => t.id === 'd1')?.accountId).toBe('new-1')
    expect(after.transactions.find((t) => t.id === 'd2')).toMatchObject({ accountId: 'acc-main', toAccountId: 'new-1' })
    expect(after.recurring[0].accountId).toBe('new-1')
    expect(after.importProfiles[0].accountId).toBe('new-1')
    expect(balance(after, 'new-1', 'EUR')).toBe(before)
    expect(queued(plan)).toEqual(['accounts|new-1', 'importProfiles|p1', 'recurring|r1', 'transactions|d1', 'transactions|d2', 'transactions|opening-new-1'])
    expect(describeAdoption(local, there, options(), NOW).rekeyed).toEqual([{ id: 'acc-cash', name: 'Contanti', newName: 'Contanti (EUR)', here: 'EUR', there: 'USD' }])
  })

  it('il vecchio saldo iniziale del conto separato se ne va anche se l’account non ne ha uno, o lo ha cancellato', () => {
    const local = device({ transactions: [opening('acc-cash', 7000), tx('d1', 'expense', 500, { accountId: 'acc-cash' })] })
    const base = account(live('accounts', acc('acc-cash', 'USD')), live('transactions', tx('s1', 'expense', 100)))
    for (const archive of [base, reduceArchive([dead('transactions', 'opening-acc-cash')], new Map(base))]) {
      const { plan, after } = merge(local, archive, options())
      expect(plan.remove).toEqual([{ tbl: 'transactions', id: 'opening-acc-cash' }])
      expect(after.transactions.map((t) => t.id).sort()).toEqual(['d1', 'opening-new-1', 's1'])
      expect(balance(after, 'acc-cash', 'EUR')).toBe(0)
      expect(balance(after, 'new-1', 'EUR')).toBe(6500)
    }
  })

  it('un conto di qui che nessun movimento usa non viene duplicato', () => {
    const there = account(live('accounts', acc('acc-cash', 'USD')), live('transactions', tx('s1', 'expense', 100)))
    const local = device({ transactions: [tx('d1', 'expense', 500)] })
    const plan = planAdoption('merge', local, there, options())
    expect(apply(local, plan).accounts.map((a) => a.id).sort()).toEqual(['acc-cash', 'acc-main'])
    expect(queued(plan)).toEqual(['transactions|d1'])
  })
})

describe('unione con valute principali diverse', () => {
  // Dispositivo in lek, account in euro. 1 lek = 0,0103 euro.
  const X = 0.0103
  const there = account(live('transactions', opening('acc-main', 100000)), live('transactions', tx('s1', 'expense', 2000)))
  const local = lekDevice({
    accounts: [acc('acc-main', 'ALL'), acc('acc-cash', 'ALL'), acc('acc-usd', 'USD', { name: 'Dollari' })],
    goals: [{ id: 'g1', name: 'Vacanza', target: 100000, color: '#000', order: 0, archived: false }],
    transactions: [
      opening('acc-main', 255000, { currency: 'ALL' }),
      opening('acc-cash', -150, { currency: 'ALL' }),
      // Saldo iniziale di un conto in dollari, col tasso salvato in unità minime (0,92 invece di 92).
      opening('acc-usd', 10000, { currency: 'USD', rate: 0.92, mainAmount: 9200 }),
      tx('lek', 'expense', 1500, { currency: 'ALL' }),
      tx('eur', 'expense', 2000, { currency: 'EUR', rate: 97, mainAmount: 1940 }),
      tx('usd', 'expense', 1000, { currency: 'USD', rate: 92, mainAmount: 920, accountId: 'acc-usd' }),
      tx('save', 'save', 5000, { currency: 'ALL', goalId: 'g1' }),
      tx('back', 'release', 1000, { currency: 'ALL', goalId: 'g1' }),
      tx('paid', 'expense', 2000, { currency: 'ALL', goalId: 'g1' }),
    ],
    recurring: [
      { id: 'rent', kind: 'expense', amount: 30000, currency: 'ALL', rate: 1, mainAmount: 30000, categoryId: 'cat-groceries', accountId: 'acc-main', note: '', frequency: 'month', start: NOW, next: NOW, active: true },
      { id: 'auto', kind: 'save', amount: 5000, currency: 'ALL', rate: 1, mainAmount: 5000, categoryId: '', accountId: 'acc-main', goalId: 'g1', note: '', frequency: 'month', start: NOW, next: NOW, active: true },
    ],
  })

  it('senza un cambio valido non si pianifica niente', () => {
    for (const rate of [undefined, 0, -1, NaN, Infinity]) expect(() => planAdoption('merge', local, there, options(rate))).toThrow('rate_required')
    // Con la stessa valuta il cambio non serve.
    expect(() => planAdoption('merge', device({ transactions: [tx('d1', 'expense', 1)] }), there, options())).not.toThrow()
  })

  it('i controvalori passano nella valuta dell’account; gli importi scritti restano', () => {
    const { after } = merge(local, there, options(X))
    const row = (id: string) => after.transactions.find((t) => t.id === id)!
    // Nella valuta del dispositivo: stesso importo, controvalore col cambio dato.
    expect(row('lek')).toMatchObject({ currency: 'ALL', amount: 1500, mainAmount: 1545, rate: X })
    // Già nella valuta dell'account: il controvalore è l'importo.
    expect(row('eur')).toMatchObject({ currency: 'EUR', amount: 2000, mainAmount: 2000, rate: 1 })
    // In una terza valuta: controvalore convertito, tasso ricavato dai due importi (9,48 € per 10 $).
    expect(row('usd')).toMatchObject({ currency: 'USD', amount: 1000, mainAmount: 948, rate: 0.948 })
    // Il tasso sbagliato del saldo iniziale in dollari viene corretto: 94,76 € per 100 $.
    expect(row('opening-acc-usd')).toMatchObject({ currency: 'USD', amount: 10000, mainAmount: 9476, rate: 0.9476 })
    // Messi da parte e ripresi sono sempre nella valuta principale: diventano euro.
    expect(row('save')).toMatchObject({ currency: 'EUR', amount: 5150, mainAmount: 5150, rate: 1 })
    expect(row('back')).toMatchObject({ currency: 'EUR', amount: 1030, mainAmount: 1030, rate: 1 })
    // Una spesa pagata da un obiettivo resta una spesa in lek.
    expect(row('paid')).toMatchObject({ currency: 'ALL', amount: 2000, mainAmount: 2060, goalId: 'g1' })
    expect(after.goals[0].target).toBe(103000)
    expect(after.recurring.find((r) => r.id === 'rent')).toMatchObject({ currency: 'ALL', amount: 30000, mainAmount: 30900, rate: X })
    expect(after.recurring.find((r) => r.id === 'auto')).toMatchObject({ currency: 'EUR', amount: 5150, mainAmount: 5150, rate: 1 })
    // I record dell'account non si toccano.
    expect(row('s1')).toEqual(tx('s1', 'expense', 2000))
    expect(after.settings).toEqual([{ id: 'main', mainCurrency: 'EUR', setup: 'done' }])
  })

  it('i conti in lek restano conti in lek, separati da quelli in euro dell’account, coi loro saldi', () => {
    const { plan, after } = merge(local, there, options(X))
    // I vecchi saldi iniziali in lek non restano sui conti in euro: quello del conto principale lo sostituisce
    // il saldo dell'account, quello dei contanti (che l'account non ha) viene tolto.
    expect(plan.remove).toEqual([{ tbl: 'transactions', id: 'opening-acc-cash' }])
    const main = after.accounts.find((a) => a.name === 'Conto (ALL)')!
    const cash = after.accounts.find((a) => a.name === 'Contanti (ALL)')!
    expect(main.currency).toBe('ALL')
    expect(after.accounts.find((a) => a.id === 'acc-main')?.currency).toBe('EUR')
    // Il saldo iniziale di ciascuno lo segue; quello dell'account resta al suo posto.
    expect(after.transactions.find((t) => t.id === `opening-${main.id}`)).toMatchObject({ amount: 255000, mainAmount: 262650, rate: X, accountId: main.id })
    // Conto in rosso: l'arrotondamento è quello del valore positivo (154,5 → 155), col segno davanti.
    expect(after.transactions.find((t) => t.id === `opening-${cash.id}`)).toMatchObject({ amount: -150, mainAmount: -155, accountId: cash.id })
    expect(after.transactions.find((t) => t.id === 'opening-acc-main')?.amount).toBe(100000)
    // Saldo di ogni conto del dispositivo, nella sua valuta: lo stesso di prima.
    expect(balance(after, String(cash.id), 'EUR')).toBe(balance(local, 'acc-cash', 'ALL'))
    // Anche coi movimenti scritti in un'altra valuta: i 20,00 € spesi dal conto in lek ne avevano tolti 1.940 L,
    // e quei lek ora stanno scritti a parte (il controvalore è passato in euro).
    expect(after.transactions.find((t) => t.id === 'eur')).toMatchObject({ currency: 'EUR', amount: 2000, mainAmount: 2000, accountAmount: 1940 })
    expect(balance(after, String(main.id), 'EUR')).toBe(balance(local, 'acc-main', 'ALL'))
    expect(balance(after, 'acc-usd', 'EUR')).toBe(balance(local, 'acc-usd', 'ALL'))
    // E niente di quello che parte esiste già nell'account.
    for (const q of plan.queue) expect(there.get(archiveKey(q.tbl, q.id))?.data).toBeUndefined()
    const preview = describeAdoption(local, there, options(), NOW)
    expect(preview.rekeyed.map((r) => r.newName)).toEqual(['Conto (ALL)', 'Contanti (ALL)'])
    expect(preview.droppedOpenings).toEqual([])
  })

  it('anteprima: quanto c’è da una parte e dall’altra, e un cambio suggerito dai movimenti', () => {
    const preview = describeAdoption(local, there, options(), NOW)
    expect(preview.device).toMatchObject({ currency: ALL, transactions: 6, openings: 3, goals: 1, recurring: 2 })
    expect(preview.account).toMatchObject({ currency: EUR, transactions: 1, openings: 1, goals: 0, recurring: 0 })
    // Il movimento fatto qui in euro dice quanti lek vale un euro: 97.
    expect(preview.rateHint).toBeCloseTo(1 / 97, 8)
    // Disponibile sul dispositivo: saldi iniziali, meno spese non pagate da obiettivi, meno il messo da parte, più il ripreso.
    expect(preview.available).toBe(255000 - 150 + 9200 - 1500 - 1940 - 920 - 5000 + 1000)
    expect(toAccountMain(preview.available, 0, 2, X)).toBe(Math.round(preview.available * X * 100))
    // Senza movimenti che lo dicano, nessun suggerimento.
    expect(describeAdoption(lekDevice({ transactions: [tx('lek', 'expense', 1500, { currency: 'ALL' })] }), there, options(), NOW).rateHint).toBeNull()
  })

  it('nell’altro verso: dispositivo in euro, account in lek (da due decimali a zero)', () => {
    // 1 euro = 97 lek.
    const lekAccount = reduceArchive([
      live('settings', { id: 'main', mainCurrency: 'ALL', setup: 'done' }),
      ...[EUR, USD, ALL].map((c) => live('currencies', c)),
      live('accounts', acc('acc-main', 'ALL')),
      live('transactions', tx('s1', 'expense', 1500, { currency: 'ALL' })),
    ])
    const euroDevice = device({
      goals: [{ id: 'g1', name: 'Vacanza', target: 100000, color: '#000', order: 0, archived: false }],
      transactions: [
        tx('d1', 'expense', 1250),
        tx('d2', 'save', 5000, { goalId: 'g1' }),
        // Messo da parte scritto in lek prima che il dispositivo passasse all'euro: vale l'importo scritto, non il controvalore.
        tx('d3', 'save', 4850, { currency: 'ALL', rate: 0.0103, mainAmount: 4996, goalId: 'g1' }),
        tx('d4', 'expense', 3000, { currency: 'ALL', rate: 0.0103, mainAmount: 31 }),
      ],
    })
    const { after } = merge(euroDevice, lekAccount, options(97))
    const row = (id: string) => after.transactions.find((t) => t.id === id)!
    // 12,50 € a 97 fanno 1.212,5 lek: arrotondato a 1.213.
    expect(row('d1')).toMatchObject({ currency: 'EUR', amount: 1250, mainAmount: 1213, rate: 97 })
    expect(row('d2')).toMatchObject({ currency: 'ALL', amount: 4850, mainAmount: 4850, rate: 1 })
    expect(row('d3')).toMatchObject({ currency: 'ALL', amount: 4850, mainAmount: 4850, rate: 1 })
    expect(row('d4')).toMatchObject({ currency: 'ALL', amount: 3000, mainAmount: 3000, rate: 1 })
    expect(after.goals[0].target).toBe(97000)
    // I 3.000 L erano usciti dal conto in euro come 0,31 €: ora che il controvalore è in lek, restano scritti a parte.
    expect(row('d4').accountAmount).toBe(31)
    expect(row('d1')).not.toHaveProperty('accountAmount')
    const conto = after.accounts.find((a) => a.name === 'Conto (EUR)')!
    expect(balance(after, String(conto.id), 'ALL')).toBe(balance(euroDevice, 'acc-main', 'EUR'))
  })

  it('quello che è passato sui conti del dispositivo resta fermo: conto in euro, giroconti, ricorrenze', () => {
    // Dispositivo in lek con un conto in euro tutto suo; account in euro. 1 lek = 0,0103 euro.
    const here = lekDevice({
      accounts: [acc('acc-main', 'ALL'), acc('acc-cash', 'ALL'), acc('acc-eur', 'EUR', { name: 'Euro' })],
      transactions: [
        opening('acc-main', 100000, { currency: 'ALL' }),
        opening('acc-eur', 20000, { rate: 97.5, mainAmount: 19500 }),
        // 5.000 L pagati dal conto in euro: usciti 51,28 €.
        tx('spesa', 'expense', 5000, { currency: 'ALL', accountId: 'acc-eur', accountAmount: 5128 }),
        // La stessa, scritta prima che l'importo sul conto esistesse.
        tx('vecchia', 'expense', 5000, { currency: 'ALL', accountId: 'acc-eur' }),
        // Giroconto di 5.000 L dal conto in lek al conto in euro: arrivati 51,28 €.
        tx('giro', 'transfer', 5000, { currency: 'ALL', toAccountId: 'acc-eur', toAccountAmount: 5128 }),
        // 10,00 $ pagati dal conto in lek: usciti 920 L.
        tx('dollari', 'expense', 1000, { currency: 'USD', rate: 92, mainAmount: 920 }),
      ],
      recurring: [{ id: 'abbonamento', kind: 'expense', amount: 1299, currency: 'EUR', rate: 97, mainAmount: 1260, categoryId: 'cat-groceries', accountId: 'acc-main', note: '', frequency: 'month', start: NOW, next: NOW, active: true }],
    })
    const { after } = merge(here, there, options(X))
    const row = (id: string) => after.transactions.find((t) => t.id === id)!
    const conto = after.accounts.find((a) => a.name === 'Conto (ALL)')!
    // Un conto nella valuta dell'account trova nel controvalore quello che c'è passato: 51,28 €, non 5.000 × 0,0103 = 51,50.
    expect(row('spesa')).toMatchObject({ currency: 'ALL', amount: 5000, mainAmount: 5128, rate: 0.010256 })
    expect(row('spesa')).not.toHaveProperty('accountAmount')
    // Dove la cifra non c'era non la si inventa: controvalore col cambio dato, niente a parte.
    expect(row('vecchia')).toMatchObject({ mainAmount: 5150, rate: X })
    expect(row('vecchia')).not.toHaveProperty('accountAmount')
    // Giroconto: il conto di partenza ha l'id nuovo, il controvalore sono gli euro arrivati.
    expect(row('giro')).toMatchObject({ accountId: conto.id, toAccountId: 'acc-eur', mainAmount: 5128 })
    expect(row('giro')).not.toHaveProperty('toAccountAmount')
    expect(row('giro')).not.toHaveProperty('accountAmount')
    // Terza valuta dal conto in lek: controvalore in euro, e i 920 L usciti restano a parte.
    expect(row('dollari')).toMatchObject({ currency: 'USD', amount: 1000, mainAmount: 948, accountAmount: 920 })
    // La ricorrenza segue il conto e si porta dietro i suoi 1.260 L a scadenza.
    expect(after.recurring.find((r) => r.id === 'abbonamento')).toMatchObject({ accountId: conto.id, currency: 'EUR', amount: 1299, mainAmount: 1299, rate: 1, accountAmount: 1260 })
    // I saldi, ognuno nella sua valuta: quelli di prima. (Il conto in euro senza la riga vecchia, che resta una stima.)
    expect(balance(after, String(conto.id), 'EUR')).toBe(balance(here, 'acc-main', 'ALL'))
    const facts = (data: LocalData): LocalData => ({ ...data, transactions: data.transactions.filter((t) => t.id !== 'vecchia') })
    expect(balance(facts(after), 'acc-eur', 'EUR')).toBe(balance(facts(here), 'acc-eur', 'ALL'))
    expect(balance(facts(here), 'acc-eur', 'ALL')).toBe(20000 - 5128 + 5128)
  })

  it('con la stessa valuta principale gli importi sui conti passano così come sono, senza riscrivere le righe', () => {
    // Dispositivo e account in euro; sul dispositivo un conto in dollari con una spesa in lek (usciti 54,35 $).
    const here = device({
      accounts: [acc('acc-main', 'EUR'), acc('acc-cash', 'EUR'), acc('acc-usd', 'USD', { name: 'Dollari' })],
      transactions: [tx('lek', 'expense', 5000, { currency: 'ALL', rate: 0.0103, mainAmount: 5150, accountId: 'acc-usd', accountAmount: 5435 })],
    })
    const { plan, after } = merge(here, there, options())
    expect(after.transactions.find((t) => t.id === 'lek')).toEqual(here.transactions[0])
    expect(plan.put.some((p) => p.tbl === 'transactions' && p.row.id === 'lek')).toBe(false)
    expect(queued(plan)).toContain('transactions|lek')
  })

  it('anteprima: il cambio può venire dai movimenti dell’account, e le scadenze future non sono “disponibile”', () => {
    // Nell'account c'è una spesa fatta in lek: 1 lek = 0,0101 euro.
    const archive = account(live('transactions', tx('s1', 'expense', 2000, { currency: 'ALL', rate: 0.0101, mainAmount: 20 })))
    const lek = lekDevice({ transactions: [tx('now', 'income', 5000, { currency: 'ALL' }), tx('later', 'expense', 3000, { currency: 'ALL', date: NOW + 10 * DAY })] })
    const preview = describeAdoption(lek, archive, options(), NOW)
    expect(preview.rateHint).toBe(0.0101)
    expect(preview.available).toBe(5000)
  })

  it('account senza impostazioni: la sua valuta è l’euro di ripiego, non quella del dispositivo', () => {
    const noSettings = reduceArchive([live('accounts', acc('acc-main', 'EUR')), live('transactions', tx('s1', 'expense', 100))])
    expect(() => planAdoption('merge', local, noSettings, options())).toThrow('rate_required')
    const plan = planAdoption('merge', local, noSettings, options(X))
    expect(apply(local, plan).settings).toEqual([{ id: 'main', mainCurrency: 'EUR' }])
    expect(queued(plan)).toContain('settings|main')
  })
})

describe('unione: stessa valuta definita con decimali diversi', () => {
  it('gli importi di qui cambiano scala insieme alla definizione', () => {
    // Yen aggiunto a mano con due decimali sul dispositivo; nell'account ne ha zero.
    const local = device({
      currencies: [EUR, { code: 'JPY', symbol: '¥', decimals: 2 }],
      accounts: [acc('acc-main', 'EUR'), acc('acc-jpy', 'JPY', { name: 'Yen' })],
      transactions: [tx('d1', 'expense', 150000, { currency: 'JPY', rate: 0.006, mainAmount: 900, accountId: 'acc-jpy' })],
    })
    const there = account(live('currencies', { code: 'JPY', symbol: '¥', decimals: 0 }), live('transactions', tx('s1', 'expense', 100)))
    const after = apply(local, planAdoption('merge', local, there, options()))
    expect(after.transactions.find((t) => t.id === 'd1')).toMatchObject({ amount: 1500, mainAmount: 900, rate: 0.006 })
    expect(after.currencies.find((c) => c.code === 'JPY')?.decimals).toBe(0)
  })

  it('anche quelli passati sui conti, nella valuta del conto', () => {
    const YEN2 = { code: 'JPY', symbol: '¥', decimals: 2 }
    const YEN0 = { code: 'JPY', symbol: '¥', decimals: 0 }
    // Stessa valuta principale. Sul conto in yen: 10,00 $ pagati (usciti 1.500,00 ¥ a due decimali), un giroconto
    // in dollari arrivato come 1.500,00 ¥, una ricorrenza.
    const local = device({
      currencies: [EUR, USD, YEN2],
      accounts: [acc('acc-main', 'EUR'), acc('acc-cash', 'EUR'), acc('acc-jpy', 'JPY', { name: 'Yen' }), acc('acc-usd', 'USD', { name: 'Dollari' })],
      transactions: [
        tx('d2', 'expense', 1000, { currency: 'USD', rate: 0.9, mainAmount: 900, accountId: 'acc-jpy', accountAmount: 150000 }),
        tx('d3', 'transfer', 1000, { currency: 'USD', rate: 0.9, mainAmount: 900, accountId: 'acc-usd', toAccountId: 'acc-jpy', toAccountAmount: 150000 }),
        tx('d4', 'expense', 2000, { currency: 'USD', rate: 0.9, mainAmount: 1800, accountId: 'acc-jpy', accountAmount: 300000 }),
      ],
      recurring: [{ id: 'r1', kind: 'expense', amount: 1000, currency: 'USD', rate: 0.9, mainAmount: 900, categoryId: 'cat-groceries', accountId: 'acc-jpy', accountAmount: 150000, note: '', frequency: 'month', start: NOW, next: NOW, active: true }],
    })
    const there = account(live('currencies', YEN0), live('transactions', tx('s1', 'expense', 100)))
    const { after } = merge(local, there, options())
    const row = (id: string) => after.transactions.find((t) => t.id === id)!
    expect(row('d2')).toMatchObject({ amount: 1000, mainAmount: 900, rate: 0.9, accountAmount: 1500 })
    expect(row('d3')).toMatchObject({ amount: 1000, mainAmount: 900, toAccountAmount: 1500 })
    expect(after.recurring.find((r) => r.id === 'r1')).toMatchObject({ amount: 1000, accountAmount: 1500 })
    // Il saldo del conto in yen vale lo stesso, nella scala nuova: −1.500,00 ¥ erano −150000, ora −1500.
    expect(balance(local, 'acc-jpy', 'EUR')).toBe(-150000 + 150000 - 300000)
    expect(balance(after, 'acc-jpy', 'EUR')).toBe(-1500 + 1500 - 3000)
  })

  it('e con valute principali diverse: il controvalore di prima, nella scala nuova, resta sul conto', () => {
    // Dispositivo in yen (a due decimali qui, zero nell'account), account in euro. 1 ¥ = 0,006 €.
    const local = device({
      settings: [{ id: 'main', mainCurrency: 'JPY' }],
      currencies: [EUR, USD, { code: 'JPY', symbol: '¥', decimals: 2 }],
      accounts: [acc('acc-main', 'JPY'), acc('acc-cash', 'JPY')],
      // 10,00 $ pagati dal conto in yen: usciti 1.500,00 ¥ (150000 a due decimali).
      transactions: [tx('d1', 'expense', 1000, { currency: 'USD', rate: 150, mainAmount: 150000 })],
    })
    const there = account(live('currencies', { code: 'JPY', symbol: '¥', decimals: 0 }))
    const { after } = merge(local, there, options(0.006))
    expect(after.transactions.find((t) => t.id === 'd1')).toMatchObject({ currency: 'USD', amount: 1000, mainAmount: 900, accountAmount: 1500 })
  })
})
