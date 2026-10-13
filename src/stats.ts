import { signedMain } from './data'
import type { Account, Category, Transaction } from './db'
import { payeeLabel, payeeOf } from './payee'

/**
 * Calcoli delle statistiche di lungo periodo ("Andamento"): quanto resta ogni mese, il saldo giorno per giorno
 * coi suoi alti e bassi, dove vanno i soldi, da dove cominciare per metterne da parte.
 * Solo funzioni pure: lo schermo le legge e basta. Importi nella valuta principale, in unità minime.
 *
 * Regole che valgono ovunque:
 * - contano solo i movimenti già avvenuti (le scadenze in arrivo stanno nella scheda del mese);
 * - giorni e mesi sono quelli locali del calendario;
 * - totali, medie e mediane usano solo mesi interi: il mese in corso si mostra a parte, non fa media;
 * - i giroconti non sono spese, i saldi iniziali non sono entrate, gli allineamenti in più non sono guadagni.
 */

// ——— Giorni e mesi ———

/** Mezzanotte locale del giorno che contiene l'istante. */
export function dayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Mezzanotte locale del giorno dopo (coi cambi d'ora non è sempre 24 ore più tardi). */
export function nextDay(day: number): number {
  const d = new Date(day)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** Primo istante del mese che contiene l'istante, spostato di `shift` mesi. */
export function monthStart(ms: number, shift = 0): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + shift, 1).getTime()
}

/** Quanti mesi di calendario separano due istanti (0 se sono nello stesso mese). */
export function monthsBetween(a: number, b: number): number {
  const x = new Date(a)
  const y = new Date(b)
  return (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth()
}

/** La lista in ordine di data (la stessa, se lo è già). */
export const byDate = (list: Transaction[]) => (list.every((tx, i) => i === 0 || list[i - 1].date <= tx.date) ? list : [...list].sort((a, b) => a.date - b.date))

/** Valore di mezzo; con un numero pari di valori la media dei due centrali, arrotondata. Zero senza valori. */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Arrotonda in giù a due cifre significative: 68.324 → 68.000. Una cifra da proporre, non un conto al centesimo. */
export function roundDown2(value: number): number {
  if (!(value > 0)) return 0
  const scale = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1)
  return Math.floor(value / scale) * scale
}

// ——— Cosa fa ogni movimento ———

/**
 * "total": i soldi che si hanno in tutto, obiettivi compresi. "available": il disponibile della schermata principale.
 * La differenza sono i soldi dentro gli obiettivi: metterli da parte non rende più poveri, quindi la linea del saldo
 * di norma non scende quando si risparmia.
 */
export type Scope = 'total' | 'available'

/** Effetto del movimento sui soldi in tutti i conti, obiettivi compresi: giroconti e obiettivi li spostano soltanto. */
export function totalDelta(tx: Transaction): number {
  if (tx.kind === 'income' || tx.kind === 'opening') return tx.mainAmount
  if (tx.kind === 'expense') return -tx.mainAmount
  return 0
}

// ——— Il saldo giorno per giorno ———

export interface DayPoint {
  /** Mezzanotte locale del giorno. */
  day: number
  /** Saldo a fine giornata. */
  value: number
  /** Di quanto è cambiato nella giornata. */
  delta: number
}

/**
 * Il saldo a fine giornata, un punto per ogni giorno da quello di `from` a quello di `now` compresi.
 * I saldi iniziali valgono dal primo punto, qualunque data abbiano: un conto aggiunto dopo, o un saldo di partenza
 * scritto in ritardo, disegnerebbe altrimenti un salto che sembra un'entrata. Così la linea si muove solo per quello
 * che entra e che esce. `base` sono i saldi iniziali delle versioni precedenti, ancora scritti sul conto.
 * `effect` sostituisce il conto di ogni movimento, per le linee che non sono né il totale né il disponibile.
 */
export function balanceSeries(
  transactions: Transaction[],
  opts: { from: number; now: number; scope?: Scope; base?: number; effect?: (tx: Transaction) => number },
): DayPoint[] {
  const delta = opts.effect ?? (opts.scope === 'available' ? signedMain : totalDelta)
  const first = dayStart(opts.from)
  let value = opts.base ?? 0
  const moves: Transaction[] = []
  for (const tx of byDate(transactions)) {
    if (tx.date > opts.now) break
    if (tx.kind === 'opening' || tx.date < first) value += delta(tx)
    else moves.push(tx)
  }
  const out: DayPoint[] = []
  let i = 0
  for (let day = first; day <= opts.now; day = nextDay(day)) {
    const end = nextDay(day)
    let moved = 0
    while (i < moves.length && moves[i].date < end) moved += delta(moves[i++])
    value += moved
    out.push({ day, value, delta: moved })
  }
  return out
}

// ——— Alti e bassi ———

export interface MonthEnvelope {
  /** Primo istante del mese. */
  month: number
  /** Il punto più basso e il più alto del mese (il primo giorno, a parità di saldo: quello in cui è successo qualcosa). */
  low: DayPoint
  high: DayPoint
  /** L'ultimo giorno del mese presente nella serie. */
  end: DayPoint
  days: number
}

/** Per ogni mese di calendario della serie, il punto più basso, il più alto e l'ultimo. */
export function monthEnvelope(points: DayPoint[]): MonthEnvelope[] {
  const out: MonthEnvelope[] = []
  for (const p of points) {
    const month = monthStart(p.day)
    let e = out[out.length - 1]
    if (!e || e.month !== month) out.push((e = { month, low: p, high: p, end: p, days: 0 }))
    if (p.value < e.low.value) e.low = p
    if (p.value > e.high.value) e.high = p
    e.end = p
    e.days++
  }
  return out
}

/** Sotto questa durata la linea è troppo corta perché il suo massimo e il suo minimo vogliano dire qualcosa: non portano la cifra scritta. */
export const MIN_DAYS_FOR_EXTREMES = 14

// ——— Salite e discese ———

/** Un ritorno indietro più piccolo di questa quota dell'altezza dell'asse non fa una svolta: il 6%, circa 10 pixel su 166. */
export const SWING_SHARE = 0.06
/** Con meno tratti interi di così, per verso, non c'è un "solito". */
export const MIN_SWINGS_FOR_USUAL = 4
/** Più (o meno) del solito: da un quarto in su (o in giù). */
export const USUAL_BAND = 0.25
/** Quanti gradini al più si segnano dentro un tratto. */
export const MAX_STEPS = 3

/** La soglia delle svolte per una linea: una quota dell'altezza dell'asse su cui è disegnata. Zero se la linea è piatta. */
export function swingThreshold(points: DayPoint[]): number {
  if (points.length < 2) return 0
  let min = Infinity
  let max = -Infinity
  for (const p of points) {
    if (p.value < min) min = p.value
    if (p.value > max) max = p.value
  }
  if (max === min) return 0
  const { lo, hi } = yAxis(min, max)
  return SWING_SHARE * (hi - lo)
}

export interface Turn {
  /** Posizione nella serie. */
  index: number
  kind: 'low' | 'high'
}

/**
 * Le svolte della linea: i giorni in cui smette di salire (un alto) o di scendere (un basso).
 * Una svolta c'è quando, dopo un estremo, la linea torna indietro di almeno `theta`: i ritorni più piccoli restano
 * dentro il tratto. Il giorno della svolta è il primo in cui la linea tocca quel valore (quello in cui è successo
 * qualcosa). In coda c'è anche l'estremo "in sospeso", non ancora confermato da un ritorno indietro, se non è l'ultimo giorno.
 */
export function turningPoints(points: DayPoint[], theta: number): Turn[] {
  const n = points.length
  if (n < 2 || !(theta > 0)) return []
  const out: Turn[] = []
  let hi = 0
  let lo = 0
  let dir: 'up' | 'down' | null = null
  for (let i = 1; i < n; i++) {
    const v = points[i].value
    if (dir === null) {
      if (v > points[hi].value) hi = i
      if (v < points[lo].value) lo = i
      if (points[hi].value - points[lo].value < theta) continue
      // Il più vecchio dei due è la prima svolta; verso l'altro la linea sta andando.
      if (hi > lo) {
        out.push({ index: lo, kind: 'low' })
        dir = 'up'
      } else {
        out.push({ index: hi, kind: 'high' })
        dir = 'down'
      }
    } else if (dir === 'up') {
      if (v > points[hi].value) hi = i
      else if (points[hi].value - v >= theta) {
        out.push({ index: hi, kind: 'high' })
        dir = 'down'
        lo = i
      }
    } else if (v < points[lo].value) lo = i
    else if (v - points[lo].value >= theta) {
      out.push({ index: lo, kind: 'low' })
      dir = 'up'
      hi = i
    }
  }
  if (dir === null) return []
  const pending = dir === 'up' ? hi : lo
  if (pending !== n - 1) out.push({ index: pending, kind: dir === 'up' ? 'high' : 'low' })
  return out
}

/** Un tratto della linea: una salita o una discesa, da una svolta alla successiva. */
export interface Swing {
  /** Il giorno d'arrivo: unico nella lista, fa da chiave. */
  id: number
  dir: 'up' | 'down'
  from: DayPoint
  to: DayPoint
  /** Posizioni nella serie. Il tratto è fatto dei giorni dopo `fromIndex` fino a `toIndex` compreso. */
  fromIndex: number
  toIndex: number
  /** Di quanto è salito o sceso il saldo: sempre positivo. */
  amount: number
  /** Giorni di calendario tra partenza e arrivo. */
  days: number
  /** "start": è il primo tratto, non si sa cosa c'era prima; "running": arriva a oggi e non è finito; null: intero. */
  open: 'start' | 'running' | null
  /** Rispetto alla salita o alla discesa solita; null se il tratto non è intero o se un solito non c'è. */
  versus: 'more' | 'less' | 'same' | null
  /** Da guardare: più grande del solito; dove un solito non c'è, uno dei due più grandi del suo verso. */
  notable: boolean
  /** I giorni che pesano di più nel verso del tratto, in ordine di data (posizioni nella serie). */
  steps: number[]
}

export interface Swings {
  theta: number
  list: Swing[]
  /** La salita solita e la discesa solita, o null. */
  usualUp: number | null
  usualDown: number | null
  /** Posizione del massimo e del minimo del periodo (il primo giorno, a parità di saldo). */
  highIndex: number
  lowIndex: number
}

/**
 * Il "solito" di un gruppo di salite (o di discese): la mediana, ma solo se sono almeno quattro e almeno metà le somiglia
 * (sta a meno di un quarto di distanza). Chi non ha un ritmo non ha un solito.
 */
export function usualSwing(amounts: number[]): number | null {
  if (amounts.length < MIN_SWINGS_FOR_USUAL) return null
  const mid = median(amounts)
  const near = amounts.filter((a) => Math.abs(a - mid) < USUAL_BAND * mid).length
  return near * 2 >= amounts.length ? mid : null
}

/**
 * La linea come catena di salite e discese: dal primo giorno all'ultimo, ogni tratto comincia dove finisce quello prima.
 * `usual` porta il solito misurato altrove (gli ultimi dodici mesi), così vale uguale per ogni periodo che si guarda;
 * senza, si misura sui tratti interi di questa linea.
 */
export function findSwings(points: DayPoint[], opts: { theta?: number; usual?: { up: number | null; down: number | null } } = {}): Swings {
  const theta = opts.theta ?? swingThreshold(points)
  const n = points.length
  let highIndex = 0
  let lowIndex = 0
  points.forEach((p, i) => {
    if (p.value > points[highIndex].value) highIndex = i
    if (p.value < points[lowIndex].value) lowIndex = i
  })
  const turns = turningPoints(points, theta)
  if (turns.length === 0) return { theta, list: [], usualUp: null, usualDown: null, highIndex, lowIndex }
  const nodes = [...new Set([0, ...turns.map((t) => t.index), n - 1])]
  const list: Swing[] = []
  for (let k = 1; k < nodes.length; k++) {
    const a = nodes[k - 1]
    const b = nodes[k]
    const diff = points[b].value - points[a].value
    // Dopo l'ultimo estremo non è più successo niente: nessun tratto, quei giorni restano all'ultimo.
    if (diff === 0) continue
    const dir = diff > 0 ? 'up' : 'down'
    const amount = Math.abs(diff)
    const steps: number[] = []
    if (b - a > 1) {
      const floor = Math.max(theta / 2, 0.15 * amount)
      const days: number[] = []
      for (let i = a + 1; i <= b; i++) if ((dir === 'up' ? points[i].delta : -points[i].delta) >= floor) days.push(i)
      days.sort((x, y) => Math.abs(points[y].delta) - Math.abs(points[x].delta) || x - y)
      steps.push(...days.slice(0, MAX_STEPS).sort((x, y) => x - y))
    }
    list.push({ id: points[b].day, dir, from: points[a], to: points[b], fromIndex: a, toIndex: b, amount, days: b - a, open: b === n - 1 ? 'running' : a === 0 ? 'start' : null, versus: null, notable: false, steps })
  }
  const whole = (dir: 'up' | 'down') => list.filter((s) => s.dir === dir && s.open === null)
  const usualUp = opts.usual ? opts.usual.up : usualSwing(whole('up').map((s) => s.amount))
  const usualDown = opts.usual ? opts.usual.down : usualSwing(whole('down').map((s) => s.amount))
  for (const dir of ['up', 'down'] as const) {
    const usual = dir === 'up' ? usualUp : usualDown
    const group = whole(dir)
    if (usual !== null) {
      for (const s of group) {
        s.versus = s.amount >= (1 + USUAL_BAND) * usual ? 'more' : s.amount <= (1 - USUAL_BAND) * usual ? 'less' : 'same'
        s.notable = s.versus === 'more'
      }
    } else if (group.length >= MIN_SWINGS_FOR_USUAL) {
      for (const s of [...group].sort((x, y) => y.amount - x.amount || x.toIndex - y.toIndex).slice(0, 2)) s.notable = true
    }
  }
  return { theta, list, usualUp, usualDown, highIndex, lowIndex }
}

/** Per ogni giorno della serie, la posizione del suo tratto nella lista (-1 se la linea non ha tratti). */
export function swingOfDay(swings: Swing[], count: number): Int32Array {
  const out = new Int32Array(count).fill(-1)
  swings.forEach((s, k) => {
    for (let i = k === 0 ? s.fromIndex : s.fromIndex + 1; i <= s.toIndex; i++) out[i] = k
  })
  // Giorni fermi in coda (dopo l'ultimo estremo non è più successo niente): restano all'ultimo tratto.
  for (let i = 1; i < count; i++) if (out[i] === -1) out[i] = out[i - 1]
  return out
}

/** I giorni dove il dito si ferma da solo: dove arriva ogni tratto (un alto o un basso) e i suoi gradini. In ordine, senza doppioni. */
export function swingStops(swings: Swing[]): number[] {
  const set = new Set<number>()
  for (const s of swings) {
    set.add(s.toIndex)
    for (const i of s.steps) set.add(i)
  }
  return [...set].sort((a, b) => a - b)
}

/** Il giorno scelto toccando: la fermata più vicina entro `reach` giorni (la prima, a pari distanza), altrimenti il giorno toccato. */
export function snapToStop(stops: number[], index: number, reach: number): number {
  let lo = 0
  let hi = stops.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stops[mid] < index) lo = mid + 1
    else hi = mid
  }
  const after = lo < stops.length ? stops[lo] : Infinity
  const before = lo > 0 ? stops[lo - 1] : -Infinity
  const best = index - before <= after - index ? before : after
  return Math.abs(best - index) <= reach ? best : index
}

/**
 * Quanti giorni di portata ha il dito: quelli che stanno in `px` pixel (due e mezzo per un dito, uno per il mouse),
 * ma mai più di un terzo di un tratto medio, e almeno uno. Zero se non ci sono tratti.
 */
export function touchReach(count: number, plotW: number, swings: number, px = 2.5): number {
  if (count < 2 || swings === 0 || plotW <= 0) return 0
  return Math.max(1, Math.min(Math.round((px * (count - 1)) / plotW), Math.round((0.3 * (count - 1)) / swings)))
}

export interface DayMove {
  /** Il movimento che ha spostato di più il saldo nel verso della giornata. */
  top: Transaction | null
  /** Quanti movimenti hanno toccato il saldo quel giorno. */
  count: number
}

/**
 * Per ogni giorno della serie, che cosa ha mosso di più il saldo e quanti movimenti lo hanno toccato.
 * Un passaggio solo sui movimenti (in ordine di data), con le stesse regole della linea: niente dopo `now`,
 * niente saldi iniziali, e conta solo ciò che sposta la linea che si sta guardando.
 */
export function dayMoves(sorted: Transaction[], points: DayPoint[], opts: { now: number; scope?: Scope }): DayMove[] {
  const out: DayMove[] = points.map(() => ({ top: null, count: 0 }))
  if (points.length === 0) return out
  const effect = opts.scope === 'available' ? signedMain : totalDelta
  const best = points.map(() => -Infinity)
  let i = 0
  for (const tx of sorted) {
    if (tx.date > opts.now) break
    if (tx.kind === 'opening' || tx.date < points[0].day) continue
    while (i + 1 < points.length && points[i + 1].day <= tx.date) i++
    const e = effect(tx)
    if (e === 0) continue
    out[i].count++
    const along = points[i].delta === 0 ? Math.abs(e) : Math.sign(points[i].delta) * e
    if (along > best[i]) {
      out[i].top = tx
      best[i] = along
    }
  }
  return out
}

/** I movimenti tra due istanti (`start` compreso, `end` escluso) in una lista ordinata per data: due ricerche binarie, nessuna scansione. */
export function sliceByDate(sorted: Transaction[], start: number, end: number): Transaction[] {
  const at = (ms: number) => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].date < ms) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  return sorted.slice(at(start), at(end))
}

// ——— Spese senza dettaglio ———

const isCashLike = (a: Account) => a.key === 'cash' || /contanti|cash|portafogli|wallet/i.test(a.name)

/**
 * I portafogli di contanti "ciechi": ci arrivano i prelievi, ma le spese segnate lì sono poche (al più la metà
 * dei prelievi). È il caso di chi preleva e poi segna i contanti in blocco, o non li segna affatto: quei soldi
 * sono usciti, ma non si vede per cosa. Si riconoscono dal comportamento nel periodo, non dal nome della categoria.
 */
export function opaqueWallets(transactions: Transaction[], accounts: Account[], from: number, to: number, now: number): Set<string> {
  const out = new Set<string>()
  for (const acc of accounts) {
    if (!isCashLike(acc)) continue
    let withdrawals = 0
    let expenses = 0
    for (const tx of transactions) {
      if (tx.date < from || tx.date >= to || tx.date > now) continue
      if (tx.kind === 'transfer' && tx.toAccountId === acc.id) withdrawals++
      if (tx.kind === 'expense' && tx.source !== 'adjust' && tx.accountId === acc.id) expenses++
    }
    if (withdrawals >= 3 && expenses <= withdrawals / 2) out.add(acc.id)
  }
  return out
}

export interface SpendContext {
  categories: Category[]
  /** I portafogli ciechi del periodo (vedi opaqueWallets). */
  wallets: Set<string>
}

/**
 * Una spesa "senza dettaglio": non dice dove sono andati i soldi. Lo sono le uscite pagate da un portafoglio cieco,
 * gli allineamenti del saldo in meno, e le spese che non hanno un esercente né una categoria vera
 * (nessuna, o la predefinita "Altro").
 */
export function isOpaque(tx: Transaction, category: Category | undefined, wallets: Set<string>): boolean {
  if (tx.kind !== 'expense') return false
  if (tx.source === 'adjust' || wallets.has(tx.accountId)) return true
  return (!tx.categoryId || category?.key === 'other') && payeeOf(tx.note) === null
}

function opaqueTest(ctx: SpendContext): (tx: Transaction) => boolean {
  const cats = new Map(ctx.categories.map((c) => [c.id, c]))
  return (tx) => isOpaque(tx, tx.categoryId ? cats.get(tx.categoryId) : undefined, ctx.wallets)
}

const feeIds = (categories: Category[]) => new Set(categories.filter((c) => c.key === 'fees').map((c) => c.id))

// ——— Cosa è successo tra due punti della linea ———

/**
 * Come si raggruppano i movimenti di un tratto: commissioni, spese senza dettaglio e allineamenti del saldo in più
 * ognuno insieme, il resto per esercente o categoria.
 */
export interface LegGroup {
  kind: 'fees' | 'opaque' | 'adjust' | 'payee' | 'category'
  /** Chiave dell'esercente, o id della categoria (vuoto se manca). */
  key: string
  /** Nome dell'esercente come si legge nelle note; per gli altri tipi lo dà lo schermo. */
  name: string
  categoryId?: string
  total: number
  count: number
  /** Per le spese senza dettaglio: almeno metà è stata pagata da un portafoglio di contanti cieco. */
  cash?: boolean
}

export interface Leg {
  from: DayPoint
  to: DayPoint
  /** Entrate vere del tratto (gli allineamenti in più stanno a parte: non sono guadagni). */
  in: number
  adjustIn: number
  /** Le uscite del tratto che hanno mosso la linea, allineamenti in meno compresi. */
  out: number
  /** Soldi messi negli obiettivi nel tratto, al netto di quelli ripresi (negativo se ne sono stati ripresi di più). */
  saved: number
  /** I gruppi più pesanti nel verso del tratto: uscite verso un basso (per esercente), entrate verso un alto (per categoria). */
  top: LegGroup[]
  /** Per un alto: le entrate degli ultimi tre giorni, quando da sole spiegano almeno metà della salita. */
  landed: { amount: number; tx: Transaction } | null
  /** Per un basso: l'uscita che da sola fa almeno metà di tutte quelle del tratto. */
  single: Transaction | null
  /** Tutti i movimenti del tratto nel suo verso, dal più grande. */
  movers: Transaction[]
}

/**
 * Cosa è successo tra due punti della linea: quanto è entrato, quanto è uscito e che cosa ha pesato di più.
 * Conta i movimenti dei giorni dopo `from` fino a `to` compreso, con le stesse regole della linea: niente di ciò
 * che viene dopo `now`, e sul disponibile le spese pagate da un obiettivo non contano (quei soldi erano già
 * da parte). I conti tornano sempre: sul totale `from + in + adjustIn − out = to`, sul disponibile
 * `from + in + adjustIn − out − saved = to`.
 */
export function explainLeg(
  transactions: Transaction[],
  from: DayPoint,
  to: DayPoint,
  kind: 'low' | 'high',
  ctx: SpendContext,
  opts: { now?: number; scope?: Scope } = {},
): Leg {
  const start = from.day === to.day ? from.day : nextDay(from.day)
  const end = nextDay(to.day)
  const now = opts.now ?? Infinity
  const available = opts.scope === 'available'
  const leg: Leg = { from, to, in: 0, adjustIn: 0, out: 0, saved: 0, top: [], landed: null, single: null, movers: [] }
  let fromWallets = 0
  const groups = new Map<string, LegGroup>()
  const names = new Map<string, string[]>()
  // Gli ultimi tre giorni del tratto: quello dell'alto e i due prima.
  const recent = new Date(to.day)
  recent.setDate(recent.getDate() - 2)
  let landedTotal = 0
  let landedTop: Transaction | null = null
  const opaque = opaqueTest(ctx)
  const fees = feeIds(ctx.categories)
  for (const tx of transactions) {
    if (tx.date < start || tx.date >= end || tx.date > now) continue
    if (tx.kind === 'save') leg.saved += tx.mainAmount
    if (tx.kind === 'release') leg.saved -= tx.mainAmount
    if (tx.kind !== 'income' && tx.kind !== 'expense') continue
    if (available && tx.kind === 'expense' && tx.goalId) continue
    // Un allineamento in più non è un guadagno: sta a parte nei totali, ma se ha fatto salire la linea va nominato.
    const adjusted = tx.kind === 'income' && tx.source === 'adjust'
    if (adjusted) leg.adjustIn += tx.mainAmount
    else if (tx.kind === 'income') leg.in += tx.mainAmount
    else leg.out += tx.mainAmount
    if ((kind === 'high') !== (tx.kind === 'income')) continue
    leg.movers.push(tx)
    if (kind === 'high' && !adjusted && tx.date >= recent.getTime()) {
      landedTotal += tx.mainAmount
      if (!landedTop || tx.mainAmount > landedTop.mainAmount) landedTop = tx
    }
    // Le uscite si raccontano per esercente (dove sono andati i soldi), le entrate per categoria (stipendio, rimborsi…):
    // la nota di uno stipendio cambia ogni mese, e mille voci "stipendio di…" non direbbero di più.
    const payee = kind === 'low' ? payeeOf(tx.note) : null
    const g: LegGroup = adjusted
      ? { kind: 'adjust', key: '', name: '', total: 0, count: 0 }
      : kind === 'low' && opaque(tx)
        ? { kind: 'opaque', key: '', name: '', total: 0, count: 0 }
        : kind === 'low' && tx.categoryId && fees.has(tx.categoryId)
          ? { kind: 'fees', key: '', name: '', total: 0, count: 0 }
          : payee
            ? { kind: 'payee', key: payee.key, name: payee.name, categoryId: tx.categoryId, total: 0, count: 0 }
            : { kind: 'category', key: tx.categoryId ?? '', name: '', categoryId: tx.categoryId, total: 0, count: 0 }
    const id = `${g.kind}:${g.key}`
    const kept = groups.get(id) ?? g
    kept.total += tx.mainAmount
    kept.count++
    groups.set(id, kept)
    if (g.kind === 'payee') names.set(id, [...(names.get(id) ?? []), g.name])
    if (g.kind === 'opaque' && ctx.wallets.has(tx.accountId)) fromWallets += tx.mainAmount
  }
  for (const [id, list] of names) groups.get(id)!.name = payeeLabel(list)
  const hidden = groups.get('opaque:')
  if (hidden) hidden.cash = fromWallets >= hidden.total / 2
  leg.movers.sort((a, b) => b.mainAmount - a.mainAmount || a.date - b.date)
  leg.top = [...groups.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)).slice(0, 3)
  const rise = to.value - from.value
  if (kind === 'high' && landedTop && rise > 0 && landedTotal >= rise / 2) leg.landed = { amount: landedTotal, tx: landedTop }
  if (kind === 'low' && leg.movers.length > 1 && leg.movers[0].mainAmount >= leg.out / 2) leg.single = leg.movers[0]
  return leg
}

// ——— Mesi interi e periodi ———

export interface FullMonths {
  /** Primo istante del primo e dell'ultimo mese intero. */
  first: number
  last: number
  count: number
}

/**
 * I mesi interi dell'archivio: dal mese del primo movimento vero se cade il primo del mese, altrimenti dal mese dopo
 * (un mese cominciato a metà non è un mese), fino al mese prima di quello in corso. Null se non ce n'è nemmeno uno.
 */
export function fullMonths(transactions: Transaction[], now: number): FullMonths | null {
  let firstTx = Infinity
  for (const tx of transactions) if (tx.kind !== 'opening' && tx.date <= now && tx.date < firstTx) firstTx = tx.date
  if (firstTx === Infinity) return null
  const first = new Date(firstTx).getDate() === 1 ? monthStart(firstTx) : monthStart(firstTx, 1)
  const last = monthStart(now, -1)
  const count = monthsBetween(first, last) + 1
  return count >= 1 ? { first, last, count } : null
}

export type Preset = 3 | 6 | 12 | 'all'

/** Gli ultimi N mesi interi (tutti, per "all"), dal più vecchio al più recente. Vuoto se non ce ne sono abbastanza. */
export function periodMonths(full: FullMonths | null, preset: Preset): number[] {
  if (!full) return []
  const n = preset === 'all' ? full.count : preset
  if (n > full.count) return []
  return Array.from({ length: n }, (_, i) => monthStart(full.last, i - n + 1))
}

/** I periodi che si possono scegliere coi mesi interi che ci sono: "tutto" sempre, gli altri solo se sono più corti. */
export function availablePresets(full: FullMonths | null): Preset[] {
  if (!full) return []
  return [...([3, 6, 12] as const).filter((n) => n < full.count), 'all']
}

/** Il periodo di pari durata subito prima, se è fatto tutto di mesi interi; altrimenti null. */
export function previousMonths(full: FullMonths | null, months: number[]): number[] | null {
  if (!full || months.length === 0) return null
  const prev = months.map((month) => monthStart(month, -months.length))
  return prev[0] >= full.first ? prev : null
}

export interface MonthFlow {
  month: number
  /** Entrate vere del mese. */
  in: number
  /** Allineamenti del saldo in più: soldi che c'erano e non erano segnati, non guadagni. */
  adjustIn: number
  /** Tutte le uscite del mese: anche quelle pagate da un obiettivo e gli allineamenti in meno. */
  out: number
  /** Di cui pagate da un obiettivo. */
  fromGoal: number
  /** Messo negli obiettivi, al netto di quanto ripreso. */
  saved: number
  /** Quello che è rimasto: entrate e allineamenti in più, meno le uscite. */
  net: number
  /** Quanti movimenti tra entrate e uscite. */
  count: number
}

/** Entrate, uscite e quello che resta per ognuno dei mesi chiesti (anche quelli senza movimenti). */
export function monthFlows(transactions: Transaction[], months: number[], now: number): MonthFlow[] {
  const rows = new Map<number, MonthFlow>(months.map((month) => [month, { month, in: 0, adjustIn: 0, out: 0, fromGoal: 0, saved: 0, net: 0, count: 0 }]))
  for (const tx of transactions) {
    if (tx.date > now) continue
    const f = rows.get(monthStart(tx.date))
    if (!f) continue
    if (tx.kind === 'save') f.saved += tx.mainAmount
    else if (tx.kind === 'release') f.saved -= tx.mainAmount
    else if (tx.kind === 'income') {
      if (tx.source === 'adjust') f.adjustIn += tx.mainAmount
      else f.in += tx.mainAmount
      f.count++
    } else if (tx.kind === 'expense') {
      f.out += tx.mainAmount
      if (tx.goalId) f.fromGoal += tx.mainAmount
      f.count++
    }
  }
  return months.map((month) => {
    const f = rows.get(month)!
    f.net = f.in + f.adjustIn - f.out
    return f
  })
}

// ——— Dove vanno i soldi ———

export interface SpendRow {
  /** Id della categoria, o chiave dell'esercente. */
  id: string
  /** Nome dell'esercente (per le categorie lo dà lo schermo). */
  name: string
  /** Per un esercente: la categoria dove finisce la maggior parte della spesa. */
  categoryId?: string
  total: number
  /** Quota su tutte le uscite del periodo, da 0 a 1. */
  share: number
  count: number
  /** La spesa tipica: mediana, non media (una spesa enorme non la sposta). */
  median: number
  /** Totale mese per mese, nell'ordine dei mesi del periodo. */
  byMonth: number[]
  /** Quando un solo mese fa almeno metà del totale: quale, e quanto pesa. */
  lumpy: { month: number; share: number } | null
  /** Variazione rispetto al periodo precedente di pari durata, in percentuale; null se non c'è o non conta. */
  deltaPct: number | null
  /** Voce comparsa in questo periodo: in quello prima non c'era. */
  isNew: boolean
}

export interface Spending {
  months: number[]
  total: number
  count: number
  perMonth: number
  /** Mediana delle uscite mensili del periodo. */
  typicalMonth: number
  /** Le spese senza dettaglio. Quando pesano almeno un decimo stanno a parte, fuori dalle righe delle categorie. */
  opaque: { total: number; share: number; count: number; cash: boolean; separate: boolean; byMonth: number[] }
  categories: SpendRow[]
  payees: SpendRow[]
  /** Quanta parte delle spese dettagliate ha un esercente, da 0 a 1. */
  payeeCoverage: number
}

/** Le uscite dei mesi dati: quelle già avvenute, allineamenti in meno compresi. */
export function spendingIn(transactions: Transaction[], months: number[], now: number): Transaction[] {
  if (months.length === 0) return []
  const from = months[0]
  const to = monthStart(months[months.length - 1], 1)
  return transactions.filter((tx) => tx.kind === 'expense' && tx.date >= from && tx.date < to && tx.date <= now)
}

/**
 * Le uscite dei mesi dati, divise per categoria e per esercente, dalla voce più pesante.
 * `prevMonths` è il periodo di pari durata subito prima (null se non è fatto di mesi interi): serve al confronto.
 * Ogni quota è una quota di tutte le uscite del periodo, anche quando le spese senza dettaglio stanno a parte.
 */
export function spendingBreakdown(transactions: Transaction[], months: number[], prevMonths: number[] | null, now: number, ctx: SpendContext): Spending {
  const n = Math.max(1, months.length)
  const spend = spendingIn(transactions, months, now)
  const prev = prevMonths ? spendingIn(transactions, prevMonths, now) : null
  const opaque = opaqueTest(ctx)
  const monthOf = (tx: Transaction) => monthsBetween(months[0], tx.date)
  const sum = (list: Transaction[]) => list.reduce((s, tx) => s + tx.mainAmount, 0)
  const total = sum(spend)
  const monthTotals = months.map(() => 0)
  for (const tx of spend) monthTotals[monthOf(tx)] += tx.mainAmount
  const typicalMonth = median(monthTotals)

  const hidden = spend.filter(opaque)
  const hiddenTotal = sum(hidden)
  const separate = total > 0 && hiddenTotal >= 0.1 * total
  const hiddenByMonth = months.map(() => 0)
  for (const tx of hidden) hiddenByMonth[monthOf(tx)] += tx.mainAmount
  const detailed = separate ? spend.filter((tx) => !opaque(tx)) : spend
  const prevDetailed = prev && separate ? prev.filter((tx) => !opaque(tx)) : prev

  const rows = (keyOf: (tx: Transaction) => string | null): { rows: SpendRow[]; groups: Map<string, Transaction[]> } => {
    const groups = new Map<string, Transaction[]>()
    for (const tx of detailed) {
      const key = keyOf(tx)
      if (key === null) continue
      const g = groups.get(key)
      if (g) g.push(tx)
      else groups.set(key, [tx])
    }
    const before = new Map<string, number>()
    for (const tx of prevDetailed ?? []) {
      const key = keyOf(tx)
      if (key !== null) before.set(key, (before.get(key) ?? 0) + tx.mainAmount)
    }
    const out: SpendRow[] = []
    for (const [id, txs] of groups) {
      const rowTotal = sum(txs)
      const byMonth = months.map(() => 0)
      for (const tx of txs) byMonth[monthOf(tx)] += tx.mainAmount
      const peak = byMonth.reduce((b, v, i) => (v > byMonth[b] ? i : b), 0)
      const prevTotal = prevDetailed ? (before.get(id) ?? 0) : null
      // Il confronto si mostra solo se dice qualcosa: almeno il 15%, e almeno il 2% di un mese tipico per ogni mese.
      const diff = prevTotal === null ? 0 : rowTotal - prevTotal
      const material = Math.abs(diff) / n >= 0.02 * typicalMonth
      out.push({
        id,
        name: '',
        total: rowTotal,
        share: total > 0 ? rowTotal / total : 0,
        count: txs.length,
        median: median(txs.map((tx) => tx.mainAmount)),
        byMonth,
        lumpy: months.length >= 3 && txs.length >= 2 && byMonth[peak] >= 0.5 * rowTotal ? { month: months[peak], share: byMonth[peak] / rowTotal } : null,
        deltaPct: prevTotal !== null && prevTotal > 0 && material && Math.abs(diff) >= 0.15 * prevTotal ? Math.round((diff / prevTotal) * 100) : null,
        isNew: prevTotal === 0 && material,
      })
    }
    return { rows: out.sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)), groups }
  }

  const categories = rows((tx) => tx.categoryId ?? '').rows
  const byPayee = rows((tx) => payeeOf(tx.note)?.key ?? null)
  let namedTotal = 0
  for (const row of byPayee.rows) {
    const txs = byPayee.groups.get(row.id)!
    const cats = new Map<string, number>()
    for (const tx of txs) cats.set(tx.categoryId ?? '', (cats.get(tx.categoryId ?? '') ?? 0) + tx.mainAmount)
    row.name = payeeLabel(txs.map((tx) => payeeOf(tx.note)!.name))
    row.categoryId = [...cats.entries()].sort((a, b) => b[1] - a[1])[0][0] || undefined
    namedTotal += row.total
  }
  const detailedTotal = sum(detailed)

  return {
    months,
    total,
    count: spend.length,
    perMonth: Math.round(total / n),
    typicalMonth,
    opaque: {
      total: hiddenTotal,
      share: total > 0 ? hiddenTotal / total : 0,
      count: hidden.length,
      cash: hiddenTotal > 0 && sum(hidden.filter((tx) => ctx.wallets.has(tx.accountId))) >= 0.5 * hiddenTotal,
      separate,
      byMonth: hiddenByMonth,
    },
    categories,
    payees: byPayee.rows,
    payeeCoverage: detailedTotal > 0 ? namedTotal / detailedTotal : 0,
  }
}

/** Le uscite del periodo che appartengono a una riga: una categoria, un esercente, o le spese senza dettaglio. */
export function rowTransactions(spend: Transaction[], separate: boolean, by: 'category' | 'payee' | 'opaque', id: string, ctx: SpendContext): Transaction[] {
  const opaque = opaqueTest(ctx)
  if (by === 'opaque') return spend.filter(opaque)
  const detailed = separate ? spend.filter((tx) => !opaque(tx)) : spend
  if (by === 'category') return detailed.filter((tx) => (tx.categoryId ?? '') === id)
  return detailed.filter((tx) => payeeOf(tx.note)?.key === id)
}

// ——— Mettere da parte ———

export interface Saving {
  /** Mesi interi su cui sono fatti i conti. */
  n: number
  /** Rimasto in tutto il periodo: entrate e allineamenti in più, meno le uscite. */
  kept: number
  /**
   * Quota rimasta di quello che è arrivato (entrate e allineamenti in più: è lo stesso conto di `kept`), mai più di 1;
   * null con meno di tre mesi o se non è arrivato niente.
   */
  rate: number | null
  /** Quello che resta in un mese tipico (mediana). */
  typical: number
  /** Quanti mesi sono finiti in positivo. */
  positive: number
  /** Il saldo nel punto più basso del mese, tipico degli ultimi tre mesi: quello che resta prima che arrivi lo stipendio. */
  cushion: number | null
  /** Lo stesso sui tre mesi prima, per vedere se cresce. */
  cushionBefore: number | null
  /** Quanti mesi di spese tipiche copre quel cuscinetto; una cifra decimale. */
  runway: number | null
}

/** I numeri del risparmio sui mesi interi del periodo. `lows` è il saldo minimo di ognuno di quei mesi, nello stesso ordine. */
export function savingSummary(flows: MonthFlow[], lows: number[]): Saving {
  const n = flows.length
  const kept = flows.reduce((s, f) => s + f.net, 0)
  const income = flows.reduce((s, f) => s + f.in + f.adjustIn, 0)
  const typicalOut = median(flows.map((f) => f.out))
  const cushion = lows.length >= 3 ? median(lows.slice(-3)) : null
  return {
    n,
    kept,
    rate: n >= 3 && income > 0 ? kept / income : null,
    typical: median(flows.map((f) => f.net)),
    positive: flows.filter((f) => f.net > 0).length,
    cushion,
    cushionBefore: lows.length >= 6 ? median(lows.slice(-6, -3)) : null,
    runway: cushion !== null && typicalOut > 0 ? Math.round((cushion / typicalOut) * 10) / 10 : null,
  }
}

export interface IdleStep {
  /** Quanto si può spostare in un obiettivo. */
  amount: number
  /** Il punto più basso toccato nella finestra. */
  floor: number
  /** Quanto sarebbe rimasto in quel punto, tolta la cifra. */
  left: number
}

/** La finestra su cui si cercano i soldi mai toccati: sei mesi. */
export const IDLE_DAYS = 183

/**
 * Soldi mai toccati: negli ultimi sei mesi il disponibile non è mai sceso sotto una certa cifra. Se ne può proporre
 * una parte da spostare in un obiettivo, lasciando in quel punto più basso almeno mezzo mese tipico di spese
 * e almeno metà di quello che c'era. È un conto sul passato, non una previsione.
 * I contanti fermi in un portafoglio cieco non contano: di solito sono già stati spesi, solo non ancora segnati;
 * per questo conto un prelievo vale come un'uscita nel giorno in cui è fatto.
 * Quello che è stato messo da parte dentro la finestra si conta come tolto fin dal primo giorno: quei soldi fermi
 * sono già stati spostati, e la proposta non deve ripetersi uguale dopo averla seguita.
 * Null se la storia è più corta della finestra, o se la cifra è troppo piccola per valere la pena.
 */
export function idleStep(transactions: Transaction[], opts: { now: number; base?: number; typicalMonth: number; wallets: Set<string> }): IdleStep | null {
  const from = dayStart(opts.now - IDLE_DAYS * 86_400_000)
  const firstTx = byDate(transactions).find((tx) => tx.kind !== 'opening')
  if (!firstTx || firstTx.date > from || !(opts.typicalMonth > 0)) return null
  const inWallet = (id: string | undefined) => !!id && opts.wallets.has(id)
  // Messo da parte dentro la finestra e ancora negli obiettivi.
  let saved = 0
  const effect = (tx: Transaction) => {
    if (tx.kind === 'save' || tx.kind === 'release') {
      // Gli obiettivi non stanno in nessun conto: quello scritto sul movimento è solo l'ultimo usato.
      if (tx.date < from) return signedMain(tx)
      // Dentro la finestra quello che si mette da parte si conta a parte, come fatto il primo giorno.
      if (tx.kind === 'save') {
        saved += tx.mainAmount
        return 0
      }
      // Riprendere dei soldi restituisce prima quelli messi via nella finestra; il di più era da parte da prima,
      // e torna disponibile quel giorno come un'entrata (balanceSeries passa i movimenti una volta sola, in ordine di data).
      const back = Math.min(saved, tx.mainAmount)
      saved -= back
      return tx.mainAmount - back
    }
    if (tx.kind === 'transfer') return inWallet(tx.toAccountId) === inWallet(tx.accountId) ? 0 : inWallet(tx.toAccountId) ? -tx.mainAmount : tx.mainAmount
    return inWallet(tx.accountId) ? 0 : signedMain(tx)
  }
  const series = balanceSeries(transactions, { from, now: opts.now, base: opts.base, effect })
  const before = Math.min(...series.map((p) => p.value))
  const floor = before - saved
  // La cifra si misura su quello che c'era prima di metterne da parte: metà di quello, meno quanto è già stato spostato.
  const amount = roundDown2(Math.min(before / 2, before - 0.5 * opts.typicalMonth) - saved)
  return amount > 0 && amount >= 0.1 * opts.typicalMonth ? { amount, floor, left: floor - amount } : null
}

export type Lever =
  | { kind: 'cash'; share: number; perMonth: number; cash: boolean }
  | { kind: 'rise'; categoryId: string; recent: number; base: number; excess: number; before: number; beforeMonths: number }
  | { kind: 'fees'; key: string; name: string; categoryId: string; count: number; months: number; total: number; half: number | null }

/** Con meno mesi interi di così non si danno suggerimenti: sarebbero rumore. */
export const MIN_MONTHS_FOR_LEVERS = 3

/**
 * Da dove cominciare: pochi suggerimenti che nascono dai movimenti del periodo, ognuno con la sua regola, in ordine fisso.
 * 1. Le spese senza dettaglio, quando sono almeno un quinto delle uscite: finché non si sa dove vanno i soldi
 *    non si sa nemmeno dove tagliare. Senza cifre di risparmio: nessuno può sapere cosa c'era dentro.
 * 2. La categoria che negli ultimi tre mesi sta sopra il suo solito (mediane, così un acquisto solo non conta).
 *    `before` è quanto si era speso nei `beforeMonths` mesi prima: una mediana zero non vuol dire "mai vista".
 * 3. Una commissione che torna almeno due volte al mese; "la metà" (di quello che è costata nel periodo) si dice
 *    solo se costa (quasi) sempre uguale.
 * `unit` è un'unità intera della valuta in unità minime (100 per l'euro, 1 per il lek).
 * `known` sono le uscite dello stesso periodo già divise, se chi chiama le ha: evita di rifare il conto.
 */
export function levers(transactions: Transaction[], months: number[], now: number, ctx: SpendContext, unit: number, known?: Spending): Lever[] {
  const n = months.length
  if (n < MIN_MONTHS_FOR_LEVERS) return []
  const spending = known ?? spendingBreakdown(transactions, months, null, now, ctx)
  const out: Lever[] = []
  const fees = feeIds(ctx.categories)
  const opaque = opaqueTest(ctx)

  if (spending.opaque.share >= 0.2) out.push({ kind: 'cash', share: spending.opaque.share, perMonth: Math.round(spending.opaque.total / n), cash: spending.opaque.cash })

  if (n >= 6) {
    let best: Extract<Lever, { kind: 'rise' }> | null = null
    for (const row of spending.categories) {
      if (fees.has(row.id)) continue
      const earlier = row.byMonth.slice(0, -3)
      const recent = median(row.byMonth.slice(-3))
      const base = median(earlier)
      const before = earlier.reduce((s, v) => s + v, 0)
      const excess = recent - base
      if (excess < Math.max(0.02 * spending.typicalMonth, 20 * unit) || recent < 1.25 * base) continue
      // Una voce saltuaria ha mediana zero: se in media prima era già a questo livello non è una salita.
      if (base === 0 && before / earlier.length >= recent / 1.25) continue
      if (!best || excess > best.excess) best = { kind: 'rise', categoryId: row.id, recent, base, excess, before, beforeMonths: earlier.length }
    }
    if (best) out.push(best)
  }

  const groups = new Map<string, Transaction[]>()
  for (const tx of spendingIn(transactions, months, now)) {
    if (!tx.categoryId || !fees.has(tx.categoryId) || opaque(tx)) continue
    const key = payeeOf(tx.note)?.key ?? ''
    const g = groups.get(key)
    if (g) g.push(tx)
    else groups.set(key, [tx])
  }
  let fee: Extract<Lever, { kind: 'fees' }> | null = null
  for (const [key, txs] of groups) {
    const total = txs.reduce((s, tx) => s + tx.mainAmount, 0)
    if (txs.length < 2 * n || total < 0.003 * spending.total || (fee && fee.total >= total)) continue
    const usual = median(txs.map((tx) => tx.mainAmount))
    const steady = txs.filter((tx) => tx.mainAmount === usual).length >= 0.8 * txs.length
    fee = {
      kind: 'fees',
      key,
      name: payeeLabel(txs.map((tx) => payeeOf(tx.note)?.name ?? '').filter(Boolean)),
      categoryId: txs[0].categoryId!,
      count: txs.length,
      months: n,
      total,
      // Metà delle volte: metà di quello che sono costate nei mesi misurati, non una stima su un anno.
      half: steady ? Math.round(total / 2) : null,
    }
  }
  if (fee) out.push(fee)
  return out
}

// ——— Per disegnare ———

/** Passo "tondo" (1, 2 o 5 per una potenza di dieci) che divide l'intervallo in al più `max` parti. */
function niceStep(span: number, max: number): number {
  if (!(span > 0)) return 1
  const raw = span / max
  const pow = 10 ** Math.floor(Math.log10(raw))
  // Mai sotto l'unità: gli importi sono interi, una tacca a metà non esiste.
  return Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow)
}

export interface Axis {
  lo: number
  hi: number
  step: number
  /** Le tacche, estremi compresi: multipli del passo da `lo` a `hi`. */
  ticks: number[]
}

/**
 * L'asse del saldo: estremi e tacche con lo stesso passo, così il punto più basso e il più alto della linea stanno
 * sempre tra due righe. Parte da zero quando il minimo è piccolo rispetto al massimo (così le altezze si confrontano
 * a occhio); se il saldo resta sempre alto parte da un valore tondo poco sotto il minimo. Con valori negativi scende
 * sotto zero. Una linea piatta sta tra lo zero e il suo valore.
 */
export function yAxis(min: number, max: number): Axis {
  if (max === min) return max === 0 ? { lo: 0, hi: 1, step: 1, ticks: [0, 1] } : yAxis(Math.min(0, min), Math.max(0, max))
  const from = min >= 0 && min <= 0.6 * max ? 0 : min
  const step = niceStep(max - from, 4)
  // "|| 0": mai uno zero col segno meno.
  const lo = Math.floor(from / step) * step || 0
  const hi = Math.ceil(max / step) * step || 0
  const ticks: number[] = []
  for (let k = 0; lo + k * step <= hi + step / 1000; k++) ticks.push(Math.round(lo + k * step))
  return { lo, hi, step, ticks }
}

/**
 * Come scrivere in breve le cifre di un asse: l'unità (migliaia o milioni) è una sola per tutte le tacche, e i decimali
 * sono quelli che servono al passo, così due tacche diverse non hanno mai la stessa scritta ("10 mila", "10,5 mila").
 * `unit` è un'unità intera della valuta in unità minime. `div` e `step` sono in unità intere.
 */
export function axisScale(ticks: number[], step: number, unit: number): { div: 1 | 1_000 | 1_000_000; decimals: number } {
  const top = Math.max(...ticks.map((v) => Math.abs(v))) / unit
  const div = top >= 1_000_000 ? 1_000_000 : top >= 10_000 ? 1_000 : 1
  const whole = step / unit
  let decimals = 0
  while (decimals < 3 && Math.abs(Math.round((whole / div) * 10 ** decimals) - (whole / div) * 10 ** decimals) > 1e-9) decimals++
  return { div, decimals }
}

/**
 * Quali mesi etichettare sotto un grafico: a passo regolare (ogni mese, ogni 2, 3, 6 o 12, poi ogni due anni…)
 * contato da gennaio, largo abbastanza perché due scritte vicine non si tocchino. L'anno va sulla prima etichetta
 * e ogni volta che cambia rispetto a quella prima: così "ott · nov · dic" non possono essere tre anni diversi.
 * `months` sono i primi istanti dei mesi, in ordine; `pitch` i pixel tra un mese e il successivo; `gap` i pixel che
 * servono a un'etichetta senza anno, `yearGap` a una con l'anno (conta quando i mesi stanno in più di un anno).
 */
export function monthLabels(months: number[], pitch: number, gap: number, yearGap: number): { month: number; withYear: boolean }[] {
  if (months.length === 0) return []
  const years = new Date(months[0]).getFullYear() !== new Date(months[months.length - 1]).getFullYear()
  const step = [1, 2, 3, 6, 12, 24, 60, 120].find((s) => s * pitch >= (years ? yearGap : gap)) ?? 120
  const out: { month: number; withYear: boolean }[] = []
  let lastYear: number | null = null
  for (const month of months) {
    const d = new Date(month)
    if ((d.getFullYear() * 12 + d.getMonth()) % step !== 0) continue
    out.push({ month, withYear: d.getFullYear() !== lastYear })
    lastYear = d.getFullYear()
  }
  // Nessun mese cade sul passo (pochi mesi, passo lungo): si scrive il primo.
  return out.length > 0 ? out : [{ month: months[0], withYear: true }]
}

/** Il giorno più vicino a un punto toccato: indice tra 0 e `count - 1` per una x tra 0 e `width`. */
export function nearestIndex(count: number, width: number, x: number): number {
  if (count <= 1 || width <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.round((x / width) * (count - 1))))
}

export interface LineMark {
  /** Posizione nella serie. */
  index: number
  kind: 'low' | 'high'
  /** Pieno e colorato: il massimo, il minimo e i tratti da guardare. Vuoto: tutti gli altri arrivi. */
  filled: boolean
  /** Con la cifra scritta accanto: solo il massimo e il minimo del periodo. */
  label: boolean
}

/**
 * I segni della linea, in ordine d'importanza: il massimo e il minimo del periodo, poi gli arrivi dei tratti da guardare
 * (dal più grande; al più `maxFilledPerKind` segni pieni per tipo, massimo e minimo compresi), poi tutti gli altri
 * arrivi, vuoti. Oggi non ha un segno suo (ha già il suo punto), a meno che sia il massimo o il minimo.
 */
export function swingMarks(points: DayPoint[], swings: Swings, maxFilledPerKind = 3): LineMark[] {
  const n = points.length
  if (n < 2 || points[swings.highIndex].value === points[swings.lowIndex].value) return []
  const label = n >= MIN_DAYS_FOR_EXTREMES
  const out: LineMark[] = [
    { index: swings.highIndex, kind: 'high', filled: true, label },
    { index: swings.lowIndex, kind: 'low', filled: true, label },
  ]
  const taken = new Set([swings.highIndex, swings.lowIndex, n - 1])
  const bySize = [...swings.list].sort((a, b) => b.amount - a.amount || a.toIndex - b.toIndex)
  const room = { high: maxFilledPerKind - 1, low: maxFilledPerKind - 1 }
  for (const s of bySize) {
    const kind = s.dir === 'up' ? 'high' : 'low'
    if (!s.notable || taken.has(s.toIndex) || room[kind] <= 0) continue
    room[kind]--
    taken.add(s.toIndex)
    out.push({ index: s.toIndex, kind, filled: true, label: false })
  }
  for (const s of bySize) {
    if (taken.has(s.toIndex)) continue
    taken.add(s.toIndex)
    out.push({ index: s.toIndex, kind: s.dir === 'up' ? 'high' : 'low', filled: false, label: false })
  }
  return out
}

/** I segni che ci stanno: nell'ordine dato, saltando quelli che finirebbero a meno di `gap` pixel (in orizzontale e in verticale) da uno già messo. */
export function placeMarks<T extends { x: number; y: number }>(marks: T[], gap: number): T[] {
  const placed: T[] = []
  for (const m of marks) if (!placed.some((p) => Math.abs(p.x - m.x) < gap && Math.abs(p.y - m.y) < gap)) placed.push(m)
  return placed
}
