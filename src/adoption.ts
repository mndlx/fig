import type { SyncedTable } from './db'

/**
 * Primo accesso su un dispositivo: come si incontrano i dati che ci sono già qui e quelli
 * dell'account. Qui c'è solo la decisione, senza database né rete: date le righe del dispositivo e
 * i dati scaricati dall'account dice cosa scrivere, cosa togliere e cosa caricare. Chi la applica
 * (sync.ts) lo fa in un'unica transazione.
 *
 * - "server": il dispositivo non ha dati della persona (solo quelli predefiniti), oppure ne ha una
 *   copia identica a quella dell'account. Vince l'account.
 * - "device": l'account non ha dati della persona (nuovo, o con le sole impostazioni lasciate da un
 *   altro dispositivo). Vince il dispositivo: i suoi dati diventano quelli dell'account, valuta compresa.
 * - "conflict": ci sono dati della persona da tutte e due le parti. Non si tocca niente finché non
 *   sceglie; se sceglie di unire, il piano è "merge".
 */

export interface RemoteChange {
  tbl: SyncedTable
  id: string
  deleted?: boolean
  data?: Row
}

export type Row = Record<string, unknown>
export type LocalData = Record<SyncedTable, Row[]>
/** Dati dell'account per chiave "tabella|id": di ogni record solo l'ultima versione scaricata. */
export type Archive = Map<string, RemoteChange>

/** Le stesse tabelle di SYNCED_TABLES in db.ts (ripetute qui per non dipendere dal database). */
export const ADOPT_TABLES: readonly SyncedTable[] = ['settings', 'currencies', 'accounts', 'categories', 'goals', 'transactions', 'rules', 'importProfiles', 'recurring']
/** Tabelle che contengono il lavoro della persona, non la configurazione di partenza. */
const USER_TABLES: readonly SyncedTable[] = ['transactions', 'goals', 'recurring']

const pk = (tbl: SyncedTable) => (tbl === 'currencies' ? 'code' : 'id')
export const rowKey = (tbl: SyncedTable, row: Row) => String(row[pk(tbl)])
export const archiveKey = (tbl: SyncedTable, id: string) => `${tbl}|${id}`
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const sign = (m: number) => (m < 0 ? -1 : 1)

/**
 * Aggiunge delle modifiche scaricate ai dati dell'account. Le pagine arrivano in ordine di revisione:
 * un record cambiato durante lo scaricamento compare due volte, e vale l'ultima.
 */
export function reduceArchive(changes: RemoteChange[], into: Archive = new Map()): Archive {
  for (const c of changes) {
    if (!ADOPT_TABLES.includes(c.tbl)) continue
    const key = archiveKey(c.tbl, c.id)
    into.delete(key)
    into.set(key, c)
  }
  return into
}

const liveData = (c: RemoteChange | undefined): Row | null => (c && !c.deleted && c.data ? c.data : null)
const liveRow = (archive: Archive, tbl: SyncedTable, id: string) => liveData(archive.get(archiveKey(tbl, id)))
function liveRows(archive: Archive, tbl: SyncedTable): Row[] {
  const out: Row[] = []
  for (const c of archive.values()) if (c.tbl === tbl && liveData(c)) out.push(c.data!)
  return out
}

/** Confronto di due record senza badare all'ordine dei campi né a quelli senza valore. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const out: Row = {}
      for (const key of Object.keys(v as Row).sort()) {
        const inner = (v as Row)[key]
        if (inner !== undefined) out[key] = sort(inner)
      }
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

/** Decide come procedere senza chiedere niente, oppure segnala che serve una scelta. */
export function classifyAdoption(local: LocalData, archive: Archive): 'server' | 'device' | 'conflict' {
  const deviceUser = USER_TABLES.flatMap((tbl) => (local[tbl] ?? []).map((row) => ({ tbl, row })))
  if (deviceUser.length === 0) return 'server'
  let accountHasData = false
  for (const c of archive.values()) {
    const data = liveData(c)
    if (!data) continue
    // Anche un saldo iniziale tenuto nel vecchio campo del conto è un dato della persona.
    if (USER_TABLES.includes(c.tbl) || (c.tbl === 'accounts' && (num(data.initialBalance) !== 0 || num(data.initialMain) !== 0))) {
      accountHasData = true
      break
    }
  }
  if (!accountHasData) return 'device'
  // Se tutto quello che c'è qui è già identico nell'account (dispositivo ripristinato da un backup) non c'è niente da chiedere.
  const atStake = deviceUser.some(({ tbl, row }) => {
    const there = liveRow(archive, tbl, rowKey(tbl, row))
    return !there || canonical(there) !== canonical(row)
  })
  return atStake ? 'conflict' : 'server'
}

export interface AdoptionPlan {
  /** Record da scrivere così come sono. */
  put: { tbl: SyncedTable; row: Row }[]
  /** Record da togliere dal dispositivo. */
  remove: { tbl: SyncedTable; id: string }[]
  /** Record del dispositivo da caricare sul server: la coda viene ricostruita da qui. */
  queue: { tbl: SyncedTable; id: string }[]
}

export interface MergeOptions {
  /** Quante unità della valuta principale dell'account vale 1 unità di quella del dispositivo. */
  rate?: number
  /** Id per i conti che diventano conti separati. */
  newId: () => string
  /** Nome a schermo di un conto (quelli predefiniti non lo hanno scritto nel record). */
  accountName: (account: Row) => string
}

/** Vince l'account: è quello che succede su un dispositivo senza dati propri. */
function planServer(local: LocalData, archive: Archive): AdoptionPlan {
  const plan: AdoptionPlan = { put: [], remove: [], queue: [] }
  const here = localKeys(local)
  for (const c of archive.values()) {
    const data = liveData(c)
    if (data) plan.put.push({ tbl: c.tbl, row: data })
    else if (here.has(archiveKey(c.tbl, c.id))) plan.remove.push({ tbl: c.tbl, id: c.id })
  }
  // Quello che esiste solo qui resta e viene caricato.
  for (const tbl of ADOPT_TABLES) for (const row of local[tbl] ?? []) if (!archive.has(archiveKey(tbl, rowKey(tbl, row)))) plan.queue.push({ tbl, id: rowKey(tbl, row) })
  return plan
}

/** Vince il dispositivo: dell'account arriva solo ciò che qui non esiste, e tutto ciò che è qui viene caricato. */
function planDevice(local: LocalData, archive: Archive): AdoptionPlan {
  const plan: AdoptionPlan = { put: [], remove: [], queue: [] }
  const here = localKeys(local)
  for (const c of archive.values()) {
    const data = liveData(c)
    if (data && !here.has(archiveKey(c.tbl, c.id))) plan.put.push({ tbl: c.tbl, row: data })
  }
  for (const tbl of ADOPT_TABLES) for (const row of local[tbl] ?? []) plan.queue.push({ tbl, id: rowKey(tbl, row) })
  return plan
}

function localKeys(local: LocalData): Set<string> {
  const keys = new Set<string>()
  for (const tbl of ADOPT_TABLES) for (const row of local[tbl] ?? []) keys.add(archiveKey(tbl, rowKey(tbl, row)))
  return keys
}

/** Un saldo iniziale del dispositivo che l'unione sostituisce con quello dell'account. */
export interface DroppedOpening {
  accountId: string
  name: string
  currency: string
  here: number
  there: number
}

/** Un conto con lo stesso id e un'altra valuta: i suoi movimenti passano a un conto separato. */
export interface RekeyedAccount {
  id: string
  name: string
  newName: string
  here: string
  there: string
}

interface MergeAnalysis {
  deviceMain: string
  accountMain: string
  /** Righe del dispositivo che restano sue (ancora da convertire), con quelle create per i conti separati. */
  mine: { tbl: SyncedTable; row: Row; changed: boolean }[]
  remove: { tbl: SyncedTable; id: string }[]
  droppedOpenings: DroppedOpening[]
  rekeyed: RekeyedAccount[]
}

/**
 * Chi tiene cosa in un'unione, prima di ogni conversione. L'account vince per i record che conosce;
 * il dispositivo tiene quelli che esistono solo qui, più quello che i suoi movimenti usano e che
 * nell'account è stato cancellato (una valuta, un conto, una categoria, un obiettivo).
 */
function analyzeMerge(local: LocalData, archive: Archive, opts: Pick<MergeOptions, 'newId' | 'accountName'>): MergeAnalysis {
  const settingsHere = (local.settings ?? []).find((s) => s.id === 'main')
  const settingsThere = liveRow(archive, 'settings', 'main')
  const deviceMain = str(settingsHere?.mainCurrency) || 'EUR'
  const accountMain = str(settingsThere?.mainCurrency) || 'EUR'
  const knows = (tbl: SyncedTable, id: string) => archive.has(archiveKey(tbl, id))
  const dead = (tbl: SyncedTable, id: string) => knows(tbl, id) && !liveRow(archive, tbl, id)

  const mine: MergeAnalysis['mine'] = []
  const remove: MergeAnalysis['remove'] = []
  const droppedOpenings: DroppedOpening[] = []
  const rekeyed: RekeyedAccount[] = []

  // ——— Conti con lo stesso id e un'altra valuta: quello del dispositivo diventa un conto separato ———
  const deviceSide = (tbl: SyncedTable) => (local[tbl] ?? []).filter((row) => !knows(tbl, rowKey(tbl, row)))
  const openingOf = new Map<string, Row>()
  for (const tx of local.transactions ?? []) if (tx.kind === 'opening') openingOf.set(str(tx.accountId), tx)
  const used = new Set<string>()
  for (const tx of deviceSide('transactions')) {
    used.add(str(tx.accountId))
    if (tx.toAccountId) used.add(str(tx.toAccountId))
  }
  for (const r of deviceSide('recurring')) used.add(str(r.accountId))
  for (const p of deviceSide('importProfiles')) used.add(str(p.accountId))

  let order = Math.max(0, ...(local.accounts ?? []).map((a) => num(a.order)), ...liveRows(archive, 'accounts').map((a) => num(a.order)))
  const moved = new Map<string, string>()
  for (const acc of local.accounts ?? []) {
    const id = str(acc.id)
    const there = liveRow(archive, 'accounts', id)
    if (!there || str(there.currency) === str(acc.currency)) continue
    if (!used.has(id) && !openingOf.has(id)) continue
    const newId = opts.newId()
    const name = opts.accountName(acc)
    const fresh: Row = { ...acc, id: newId, name: `${name} (${str(acc.currency)})`, order: ++order }
    delete fresh.key
    moved.set(id, newId)
    mine.push({ tbl: 'accounts', row: fresh, changed: true })
    rekeyed.push({ id, name, newName: str(fresh.name), here: str(acc.currency), there: str(there.currency) })
  }
  const point = (id: unknown) => moved.get(str(id)) ?? id

  // ——— Riga per riga: cosa resta del dispositivo ———
  const kept = new Set<string>()
  const keep = (tbl: SyncedTable, row: Row, changed = false) => {
    mine.push({ tbl, row, changed })
    kept.add(archiveKey(tbl, rowKey(tbl, row)))
  }
  /** Record che il dispositivo ha e che nell'account risultano cancellati: si decide dopo, in base a chi li usa. */
  const buried = new Map<string, { tbl: SyncedTable; row: Row }>()

  for (const tbl of ADOPT_TABLES) {
    for (const row of local[tbl] ?? []) {
      const id = rowKey(tbl, row)
      // Saldo iniziale di un conto che diventa separato: lo segue, con un id nuovo.
      if (tbl === 'transactions' && row.kind === 'opening' && moved.has(str(row.accountId))) {
        const newAccount = moved.get(str(row.accountId))!
        keep(tbl, { ...row, id: `opening-${newAccount}`, accountId: newAccount }, true)
        // Il vecchio record, se l'account non lo sovrascrive, se ne va.
        if (!liveRow(archive, tbl, id)) remove.push({ tbl, id })
        continue
      }
      if (liveRow(archive, tbl, id)) {
        // Lo stesso saldo iniziale da tutte e due le parti: resta quello dell'account, e lo si dice.
        if (tbl === 'transactions' && row.kind === 'opening') {
          const there = liveRow(archive, tbl, id)!
          const account = (local.accounts ?? []).find((a) => a.id === row.accountId)
          if (num(there.amount) !== num(row.amount)) {
            droppedOpenings.push({ accountId: str(row.accountId), name: account ? opts.accountName(account) : '', currency: str(row.currency), here: num(row.amount), there: num(there.amount) })
          }
        }
        continue
      }
      // Il conto dell'account tiene ancora il saldo iniziale nel suo vecchio campo: è lui il saldo iniziale che resta.
      // Lasciando quello di qui, l'app lo prenderebbe per buono e azzererebbe il campo dell'account su ogni dispositivo.
      if (tbl === 'transactions' && row.kind === 'opening') {
        const legacy = liveRow(archive, 'accounts', str(row.accountId))
        if (legacy && (num(legacy.initialBalance) !== 0 || num(legacy.initialMain) !== 0)) {
          if (num(legacy.initialBalance) !== num(row.amount)) {
            droppedOpenings.push({ accountId: str(row.accountId), name: opts.accountName(legacy), currency: str(row.currency), here: num(row.amount), there: num(legacy.initialBalance) })
          }
          remove.push({ tbl, id })
          continue
        }
      }
      if (dead(tbl, id)) {
        buried.set(archiveKey(tbl, id), { tbl, row })
        continue
      }
      // Esiste solo qui.
      if (tbl === 'transactions') keep(tbl, { ...row, accountId: point(row.accountId), ...(row.toAccountId ? { toAccountId: point(row.toAccountId) } : {}) }, moved.has(str(row.accountId)) || moved.has(str(row.toAccountId)))
      else if (tbl === 'recurring' || tbl === 'importProfiles') keep(tbl, { ...row, accountId: point(row.accountId) }, moved.has(str(row.accountId)))
      // Senza impostazioni nell'account la sua valuta è quella di ripiego: non diventa in silenzio quella del dispositivo.
      else if (tbl === 'settings' && id === 'main') keep(tbl, { ...row, mainCurrency: accountMain }, deviceMain !== accountMain)
      else keep(tbl, row)
    }
  }

  // ——— Cancellati nell'account ma ancora usati dai dati del dispositivo: restano e tornano nell'account ———
  // Si ripete finché non cambia più niente: un conto recuperato può a sua volta richiedere la sua valuta.
  const surviving = (tbl: SyncedTable, id: string) => kept.has(archiveKey(tbl, id)) || !!liveRow(archive, tbl, id)
  let again = true
  while (again) {
    again = false
    const wanted = new Set<string>()
    for (const { tbl, row } of mine) {
      if (tbl === 'transactions') {
        wanted.add(archiveKey('currencies', str(row.currency)))
        wanted.add(archiveKey('accounts', str(row.accountId)))
        if (row.toAccountId) wanted.add(archiveKey('accounts', str(row.toAccountId)))
        if (row.categoryId) wanted.add(archiveKey('categories', str(row.categoryId)))
        if (row.goalId) wanted.add(archiveKey('goals', str(row.goalId)))
      } else if (tbl === 'recurring') {
        wanted.add(archiveKey('currencies', str(row.currency)))
        wanted.add(archiveKey('accounts', str(row.accountId)))
        if (row.categoryId) wanted.add(archiveKey('categories', str(row.categoryId)))
        if (row.goalId) wanted.add(archiveKey('goals', str(row.goalId)))
      } else if (tbl === 'accounts') wanted.add(archiveKey('currencies', str(row.currency)))
      else if (tbl === 'importProfiles') wanted.add(archiveKey('accounts', str(row.accountId)))
      else if (tbl === 'rules') wanted.add(archiveKey('categories', str(row.categoryId)))
    }
    // Anche un saldo iniziale è un uso del conto: se nell'account conto e saldo risultano cancellati ma qui
    // quel conto ha dei soldi, non spariscono in silenzio.
    for (const { tbl, row } of buried.values()) if (tbl === 'transactions' && row.kind === 'opening' && num(row.amount) !== 0) wanted.add(archiveKey('accounts', str(row.accountId)))
    for (const [key, { tbl, row }] of buried) {
      const referenced = wanted.has(key)
      // Un saldo iniziale cancellato nell'account non è una versione più vecchia di quello di qui: se il conto resta, resta anche lui.
      const openingOfSurvivor = tbl === 'transactions' && row.kind === 'opening' && surviving('accounts', str(row.accountId))
      if (!referenced && !openingOfSurvivor) continue
      buried.delete(key)
      keep(tbl, row)
      again = true
    }
  }
  for (const { tbl, row } of buried.values()) remove.push({ tbl, id: rowKey(tbl, row) })

  return { deviceMain, accountMain, mine, remove, droppedOpenings, rekeyed }
}

/** Decimali di ogni valuta sul dispositivo (prima dell'unione) e come risulteranno dopo. */
function decimalsOf(local: LocalData, archive: Archive) {
  const here = new Map<string, number>()
  for (const c of local.currencies ?? []) here.set(str(c.code), num(c.decimals))
  const there = new Map<string, number>()
  for (const c of liveRows(archive, 'currencies')) there.set(str(c.code), num(c.decimals))
  return {
    device: (code: string) => here.get(code) ?? 2,
    merged: (code: string) => there.get(code) ?? here.get(code) ?? 2,
  }
}

/**
 * Controvalore nella valuta principale dell'account di una cifra espressa in quella del dispositivo.
 * `x` = quante unità della valuta dell'account vale 1 unità di quella del dispositivo.
 */
export function toAccountMain(minor: number, deviceDecimals: number, accountDecimals: number, x: number): number {
  if (x === 1 && deviceDecimals === accountDecimals) return minor
  // Segno a parte: l'arrotondamento di un negativo non deve dare un centesimo di differenza rispetto al positivo.
  return sign(minor) * Math.round((Math.abs(minor) / 10 ** deviceDecimals) * x * 10 ** accountDecimals)
}

/** Piano dell'unione: l'account vince per quello che conosce, il resto del dispositivo viene convertito e caricato. */
function planMerge(local: LocalData, archive: Archive, opts: MergeOptions): AdoptionPlan {
  const a = analyzeMerge(local, archive, opts)
  const gap = a.deviceMain !== a.accountMain
  const x = gap ? Number(opts.rate) : 1
  if (gap && !(Number.isFinite(x) && x > 0)) throw new Error('rate_required')

  const dec = decimalsOf(local, archive)
  const toMain = (m: number) => toAccountMain(m, dec.device(a.deviceMain), dec.merged(a.accountMain), x)
  // Stesso codice di valuta definito con decimali diversi dalle due parti: gli importi di qui cambiano scala.
  const scale = (m: number, code: string) => (dec.device(code) === dec.merged(code) ? m : sign(m) * Math.round(Math.abs(m) * 10 ** (dec.merged(code) - dec.device(code))))
  const sameScale = dec.device(a.deviceMain) === dec.merged(a.accountMain)

  /**
   * Messi da parte e ripresi si leggono sempre nella valuta principale: passano a quella dell'account.
   * Se erano già scritti in quella (dispositivo che ha cambiato valuta principale) vale l'importo scritto.
   */
  const inMain = (row: Row): Row => {
    const value = str(row.currency) === a.accountMain ? scale(num(row.amount), a.accountMain) : toMain(num(row.mainAmount))
    return { ...row, currency: a.accountMain, amount: value, mainAmount: value, rate: 1 }
  }
  // Valuta di ogni conto dopo l'unione: quelli che restano del dispositivo (compresi i conti separati), poi quelli dell'account.
  const mineAccounts = new Map(a.mine.filter((m) => m.tbl === 'accounts').map((m) => [str(m.row.id), str(m.row.currency)]))
  const accountCurrency = (id: unknown): string | undefined => {
    if (!id) return undefined
    const there = liveRow(archive, 'accounts', str(id))
    return mineAccounts.get(str(id)) ?? (there ? str(there.currency) : undefined) ?? (local.accounts ?? []).map((acc) => (acc.id === id ? str(acc.currency) : undefined)).find(Boolean)
  }
  type Sides = { from?: string; to?: string }
  /**
   * Gli altri restano con l'importo scritto; cambia il controvalore, portato col cambio (non rifatto da importo × tasso).
   * `sides` sono le valute dei conti toccati. Quello che è passato su ognuno non cambia, ma dove sta scritto sì
   * (come nel cambio della valuta principale, vedi rebaseTransaction in money.ts): un conto nella valuta del
   * dispositivo lo leggeva nel controvalore, che ora passa a un'altra valuta, quindi va salvato a parte; un conto
   * nella valuta dell'account lo trova nel controvalore, che diventa esattamente quella cifra.
   */
  const withValue = (row: Row, sides: Sides): Row => {
    const code = str(row.currency)
    const amount = scale(num(row.amount), code)
    const own = (value: unknown, currency: string) => (typeof value === 'number' && Number.isFinite(value) ? scale(value, currency) : null)
    // Importo sul conto prima dell'unione, già nella scala che la sua valuta avrà dopo.
    const was = (side: 'from' | 'to'): number | null => {
      const currency = sides[side]
      if (!currency) return null
      if (currency === code) return amount
      if (currency === a.deviceMain) return scale(num(row.mainAmount), a.deviceMain)
      return own(side === 'from' ? row.accountAmount : row.toAccountAmount, currency)
    }
    const kept = (side: 'from' | 'to') => (sides[side] && sides[side] !== code && sides[side] !== a.accountMain ? was(side) : null)
    const onAccounts = (next: Row): Row => {
      const from = kept('from')
      const to = kept('to')
      if (from === null && to === null && next.accountAmount === undefined && next.toAccountAmount === undefined) return next
      const out = { ...next }
      if (from !== null) out.accountAmount = from
      else delete out.accountAmount
      if (to !== null) out.toAccountAmount = to
      else delete out.toAccountAmount
      return canonical(out) === canonical(next) ? next : out
    }
    if (code === a.accountMain) return onAccounts(gap || amount !== num(row.amount) ? { ...row, amount, mainAmount: amount, rate: 1 } : row)
    if (!gap) {
      const mainAmount = toMain(num(row.mainAmount))
      return onAccounts(amount === num(row.amount) && mainAmount === num(row.mainAmount) ? row : { ...row, amount, mainAmount })
    }
    // Un conto nella valuta dell'account: il controvalore è quello che c'è passato.
    const landed = (sides.from === a.accountMain ? was('from') : null) ?? (sides.to === a.accountMain ? was('to') : null)
    const exact = landed !== null && landed !== 0 && amount !== 0
    const mainAmount = exact ? sign(amount) * Math.abs(landed) : toMain(num(row.mainAmount))
    // Nella valuta del dispositivo il tasso è il cambio dato; nelle altre (o se il controvalore non viene da lì)
    // lo si ricava dai due importi: quello salvato può essere sbagliato, per esempio nei saldi iniziali dei conti in valuta.
    let rate = x
    if (code !== a.deviceMain || exact) {
      rate = amount !== 0 ? Number((Math.abs(mainAmount) / 10 ** dec.merged(a.accountMain) / (Math.abs(amount) / 10 ** dec.merged(code))).toPrecision(10)) : num(row.rate) * x
    }
    return onAccounts({ ...row, amount, mainAmount, rate })
  }
  const convert = (tbl: SyncedTable, row: Row): Row => {
    if (tbl === 'transactions') return row.kind === 'save' || row.kind === 'release' ? inMain(row) : withValue(row, { from: accountCurrency(row.accountId), to: accountCurrency(row.toAccountId) })
    if (tbl === 'recurring') return row.kind === 'save' ? inMain(row) : withValue(row, { from: accountCurrency(row.accountId) })
    // La cifra da raggiungere di un obiettivo è nella valuta principale.
    if (tbl === 'goals') return gap || !sameScale ? { ...row, target: toMain(num(row.target)) } : row
    return row
  }

  const plan: AdoptionPlan = { put: [], remove: a.remove, queue: [] }
  for (const c of archive.values()) {
    const data = liveData(c)
    if (data) plan.put.push({ tbl: c.tbl, row: data })
  }
  for (const item of a.mine) {
    const row = convert(item.tbl, item.row)
    // Una riga per cui non cambia niente resta com'è, senza riscriverla.
    if (item.changed || canonical(row) !== canonical(item.row)) plan.put.push({ tbl: item.tbl, row })
    plan.queue.push({ tbl: item.tbl, id: rowKey(item.tbl, row) })
  }
  return plan
}

/**
 * Cosa fare sul dispositivo. Non scrive niente: restituisce le operazioni.
 * Per "merge" lancia `rate_required` se le valute principali sono diverse e manca un cambio valido.
 */
export function planAdoption(mode: 'server' | 'device' | 'merge', local: LocalData, archive: Archive, opts?: MergeOptions): AdoptionPlan {
  if (mode === 'server') return planServer(local, archive)
  if (mode === 'device') return planDevice(local, archive)
  if (!opts) throw new Error('merge_options_required')
  return planMerge(local, archive, opts)
}

// ——— Quello che si mostra a chi deve scegliere ———

export interface CurrencyInfo {
  code: string
  symbol: string
  decimals: number
}

export interface AdoptionSide {
  currency: CurrencyInfo
  /** Movimenti veri: i saldi iniziali si contano a parte. */
  transactions: number
  openings: number
  goals: number
  recurring: number
  first: number | null
  last: number | null
}

export interface AdoptionPreview {
  device: AdoptionSide
  account: AdoptionSide
  /** Movimenti, obiettivi e ricorrenti che l'unione caricherebbe nell'account. */
  onlyHere: number
  droppedOpenings: DroppedOpening[]
  rekeyed: RekeyedAccount[]
  /** Valute definite da una parte o dall'altra (dove coincidono vale quella dell'account), per mostrare gli importi. */
  currencies: CurrencyInfo[]
  /** Disponibile di oggi sul dispositivo, nella sua valuta principale. */
  available: number
  /** Cambio suggerito dalla storia dei movimenti (1 valuta del dispositivo = x valuta dell'account), se c'è. */
  rateHint: number | null
}

function describeSide(rows: (tbl: SyncedTable) => Row[], main: string): AdoptionSide {
  const all = rows('transactions')
  const real = all.filter((tx) => tx.kind !== 'opening')
  const dates = real.map((tx) => num(tx.date)).filter((d) => d > 0)
  const def = rows('currencies').find((c) => c.code === main)
  return {
    currency: { code: main, symbol: str(def?.symbol) || main, decimals: def ? num(def.decimals) : 2 },
    transactions: real.length,
    openings: all.length - real.length,
    goals: rows('goals').length,
    recurring: rows('recurring').length,
    first: dates.length ? Math.min(...dates) : null,
    last: dates.length ? Math.max(...dates) : null,
  }
}

/** Effetto di un movimento sul disponibile (lo stesso conto di signedMain in data.ts, qui senza database). */
function availableDelta(tx: Row): number {
  if (tx.kind === 'income' || tx.kind === 'release' || tx.kind === 'opening') return num(tx.mainAmount)
  if (tx.kind === 'expense') return tx.goalId ? 0 : -num(tx.mainAmount)
  if (tx.kind === 'save') return -num(tx.mainAmount)
  return 0
}

export function describeAdoption(local: LocalData, archive: Archive, opts: Pick<MergeOptions, 'accountName'>, now = Date.now()): AdoptionPreview {
  // Gli id nuovi qui non contano: serve solo sapere quali conti diventerebbero separati.
  const a = analyzeMerge(local, archive, { ...opts, newId: () => 'preview' })
  const latest = (rows: Row[], pick: (tx: Row) => boolean) => rows.filter(pick).sort((p, q) => num(q.date) - num(p.date))[0]
  let rateHint: number | null = null
  if (a.deviceMain !== a.accountMain) {
    // Un movimento fatto qui nella valuta dell'account dice quanto vale; i saldi iniziali no (il loro tasso può essere sbagliato).
    const here = latest(local.transactions ?? [], (tx) => tx.kind !== 'opening' && tx.currency === a.accountMain && num(tx.rate) > 0)
    const there = latest(liveRows(archive, 'transactions'), (tx) => tx.kind !== 'opening' && tx.currency === a.deviceMain && num(tx.rate) > 0)
    if (here) rateHint = 1 / num(here.rate)
    else if (there) rateHint = num(there.rate)
  }
  const currencies = new Map<string, CurrencyInfo>()
  for (const c of [...(local.currencies ?? []), ...liveRows(archive, 'currencies')]) currencies.set(str(c.code), { code: str(c.code), symbol: str(c.symbol) || str(c.code), decimals: num(c.decimals) })
  return {
    currencies: [...currencies.values()],
    device: describeSide((tbl) => local[tbl] ?? [], a.deviceMain),
    account: describeSide((tbl) => liveRows(archive, tbl), a.accountMain),
    onlyHere: a.mine.filter((m) => USER_TABLES.includes(m.tbl)).length,
    droppedOpenings: a.droppedOpenings,
    rekeyed: a.rekeyed,
    available: (local.transactions ?? []).filter((tx) => num(tx.date) <= now).reduce((sum, tx) => sum + availableDelta(tx), 0),
    rateHint,
  }
}
