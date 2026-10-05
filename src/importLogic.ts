import type { Transaction } from './db'

/**
 * Logica dell'import degli estratti conto, separata dalla schermata per poterla provare:
 * riconoscere i movimenti già presenti, suggerire una categoria, tenere fermo il saldo
 * quando si importa lo storico precedente al saldo iniziale.
 */

export type RowKind = 'expense' | 'income'

/** Una riga dell'estratto vista dal conto: uscita o entrata, importo positivo in unità minime. */
export interface ImportRow {
  index: number
  date: number
  kind: RowKind
  amount: number
}

const DAY = 86_400_000

export function dayStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Cosa fa a un conto un movimento già in FIG: uscita o entrata e di quanto, nella valuta del conto.
 * I giroconti contano (un prelievo al bancomat è un'uscita dal conto); saldi iniziali e
 * accantonamenti negli obiettivi no, perché non sono movimenti della banca.
 */
export function accountEffect(tx: Transaction, accountId: string, currency: string): { kind: RowKind; amount: number } | null {
  if (tx.currency !== currency) return null
  if (tx.kind === 'expense' && tx.accountId === accountId) return { kind: 'expense', amount: tx.amount }
  if (tx.kind === 'income' && tx.accountId === accountId) return { kind: 'income', amount: tx.amount }
  if (tx.kind === 'transfer') {
    if (tx.accountId === accountId) return { kind: 'expense', amount: tx.amount }
    if (tx.toAccountId === accountId) return { kind: 'income', amount: tx.amount }
  }
  return null
}

export interface ExistingMatch {
  /** Stesso giorno: quasi certamente lo stesso movimento. Altrimenti è solo probabile. */
  exact: boolean
  /** Data del movimento già in FIG. */
  date: number
}

/**
 * Per ogni riga dell'estratto, il movimento già in FIG che le corrisponde (stesso conto, verso e importo).
 * Ogni movimento di FIG copre una riga sola: due caffè uguali nello stesso giorno con uno solo già
 * registrato lasciano l'altro da importare. Prima le corrispondenze nello stesso giorno, poi quelle
 * a pochi giorni di distanza (la banca contabilizza spesso dopo la data del pagamento).
 */
export function matchExisting(rows: ImportRow[], transactions: Transaction[], accountId: string, currency: string, windowDays = 3): Map<number, ExistingMatch> {
  const pool = transactions.flatMap((tx) => {
    const effect = accountEffect(tx, accountId, currency)
    return effect ? [{ ...effect, date: tx.date, day: dayStart(tx.date), used: false }] : []
  })
  const out = new Map<number, ExistingMatch>()
  for (const row of rows) {
    const day = dayStart(row.date)
    const hit = pool.find((p) => !p.used && p.kind === row.kind && p.amount === row.amount && p.day === day)
    if (!hit) continue
    hit.used = true
    out.set(row.index, { exact: true, date: hit.date })
  }
  for (const row of rows) {
    if (out.has(row.index)) continue
    const day = dayStart(row.date)
    let best: (typeof pool)[number] | null = null
    for (const p of pool) {
      if (p.used || p.kind !== row.kind || p.amount !== row.amount) continue
      const gap = Math.abs(p.day - day)
      if (gap > windowDays * DAY + DAY / 2) continue
      if (!best || gap < Math.abs(best.day - day)) best = p
    }
    if (!best) continue
    best.used = true
    out.set(row.index, { exact: false, date: best.date })
  }
  return out
}

/** Suggerimento per una riga: una categoria predefinita (per chiave) oppure un giroconto verso i contanti. */
export type Suggestion = { category: string } | { cash: true }

const HINTS: [RowKind, RegExp, Suggestion][] = [
  // Le commissioni vengono prima dei prelievi: "commissione prelievo" è una spesa, non un giroconto.
  ['expense', /commission|spese (di )?tenuta|canone (conto|mensile)|imposta di bollo|\bbollo\b|\bfees?\b|service charge|komision/, { category: 'fees' }],
  // Prelievi: soldi che passano dal conto ai contanti, non una spesa.
  ['expense', /preliev|bancomat|\batm\b|withdrawal|cash ?point|t[eë]rheqje/, { cash: true }],
  ['expense', /netflix|spotify|disney|prime video|amazon prime|apple\.com|youtube|icloud|abbonament|subscription/, { category: 'subscriptions' }],
  ['expense', /esselunga|conad|\bcoop\b|lidl|carrefour|eurospin|penny|\baldi\b|\bpam\b|\bspar\b|iper|supermerc|supermarket|grocer|tesco|sainsbury|ushqimor/, { category: 'groceries' }],
  ['expense', /enel|\beni\b|a2a|\biren\b|\bhera\b|bollett|\bluce\b|\bgas\b|acqua|\btim\b|vodafone|windtre|iliad|fastweb|telecom|electric|utility|oshee|ujësjell|ujesjell/, { category: 'bills' }],
  ['expense', /trenitalia|\bitalo\b|ferrov|metro|\btaxi\b|\buber\b|benzin|carburant|\bq8\b|\besso\b|\bagip\b|autostrad|telepass|parchegg|parking|\bbus\b|fuel|petrol|railway/, { category: 'transport' }],
  ['expense', /ristorant|trattoria|pizzeria|osteria|mcdonald|burger|sushi|kebab|just ?eat|deliveroo|glovo|restaurant|restorant/, { category: 'lunch' }],
  ['expense', /\bbar\b|caff[eè]|coffee|starbucks|\bkafe\b|pasticceria/, { category: 'coffee' }],
  ['expense', /farmaci|pharmacy|medic|dentist|ospedale|ticket sanit|hospital|barnator/, { category: 'health' }],
  ['expense', /\bzara\b|h&m|\bovs\b|decathlon|\bnike\b|adidas|zalando|abbigliament|clothing/, { category: 'clothes' }],
  ['expense', /affitto|locazione|condomini|\bikea\b|leroy merlin|\brent\b|\bqira\b/, { category: 'home' }],
  ['expense', /cinema|teatro|\bpub\b|ticketone|concert|museo|museum/, { category: 'goingOut' }],
  ['income', /stipendi|emolument|salary|payroll|pension|\bpaga\b|\brroga\b/, { category: 'salary' }],
  ['income', /rimbors|storno|refund|\breso\b|chargeback/, { category: 'refunds' }],
]

/** Categoria probabile dalla descrizione della banca; null se non c'è un indizio chiaro. */
export function suggest(desc: string, kind: RowKind): Suggestion | null {
  const text = desc.toLowerCase()
  for (const [k, re, suggestion] of HINTS) if (k === kind && re.test(text)) return suggestion
  return null
}

/**
 * Saldo iniziale da usare quando si importano movimenti più vecchi del saldo iniziale stesso.
 * Quel saldo è "quanto c'era sul conto quel giorno", quindi comprende già quei movimenti:
 * per aggiungerli come storico lo si riporta a prima del più vecchio, togliendo il loro effetto.
 * Così il saldo di oggi resta identico. Null se non c'è niente da spostare.
 */
export function openingForHistory(opening: { amount: number; date: number }, rows: { date: number; kind: RowKind; amount: number }[]): { amount: number; date: number } | null {
  const limit = dayStart(opening.date)
  const earlier = rows.filter((r) => r.date < limit)
  if (earlier.length === 0) return null
  const net = earlier.reduce((sum, r) => sum + (r.kind === 'income' ? r.amount : -r.amount), 0)
  return { amount: opening.amount - net, date: dayStart(Math.min(...earlier.map((r) => r.date))) }
}
