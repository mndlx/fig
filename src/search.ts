import type { Transaction } from './db'

/**
 * Ricerca e ordinamento dei movimenti: le parti che non dipendono dallo schermo.
 * Si cerca senza badare a maiuscole e accenti ("universita" trova "Università" e viceversa), e un importo si può
 * scrivere come lo si legge: coi punti o le virgole delle migliaia, col segno o col simbolo della valuta.
 */

/** Minuscole, senza accenti, e con un solo tipo di apostrofo (quello dritto: la tastiera del telefono mette l'altro). */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ′´`]/g, "'")
    .toLowerCase()
}

/** Come si ordinano i risultati: per data (dai più recenti o dai più vecchi) o per importo (dal più alto o dal più basso). */
export type SortOrder = 'recent' | 'oldest' | 'high' | 'low'

export const SORT_ORDERS: SortOrder[] = ['recent', 'oldest', 'high', 'low']

/**
 * I movimenti nell'ordine chiesto, senza toccare la lista di partenza. Per importo conta la grandezza
 * (un'entrata da 500 sta sopra un'uscita da 300, e un saldo iniziale in rosso vale per quanto è grande),
 * nella valuta principale; a parità prima i più recenti. Due movimenti dello stesso istante restano come nel ramo
 * del mese: prima quello aggiunto per ultimo; solo "dai più vecchi" li mette nell'ordine in cui sono stati aggiunti.
 */
export function sortTransactions(list: Transaction[], order: SortOrder): Transaction[] {
  if (order === 'oldest') return [...list].sort((a, b) => a.date - b.date)
  const out = [...list].reverse()
  if (order === 'recent') return out.sort((a, b) => b.date - a.date)
  const dir = order === 'high' ? -1 : 1
  return out.sort((a, b) => dir * (Math.abs(a.mainAmount) - Math.abs(b.mainAmount)) || b.date - a.date)
}

/** Dove si cerca, per un movimento: il testo (già passato da `fold`) e i suoi importi scritti senza migliaia ("1250.00"). */
export interface Haystack {
  text: string
  amounts: string[]
}

/** L'importo come lo si cerca: senza segno né migliaia, col punto decimale e tutte le cifre decimali della valuta. */
export function amountText(minor: number, decimals: number): string {
  return (Math.abs(minor) / 10 ** decimals).toFixed(decimals)
}

/**
 * Se una parola è un importo, i modi in cui si può leggere: "1.250" e "1,250" sono 1250 (migliaia all'italiana o
 * all'inglese) ma anche 1.250; "12,50" è 12.50; "1.250,00" e "1,250.00" sono 1250.00. Il segno e il simbolo della
 * valuta attaccati non contano ("-4000", "4.000€"). Vuoto se la parola non è un numero.
 * `symbols` sono simboli e sigle delle valute, già passati da `fold`.
 */
export function amountForms(word: string, symbols: string[] = []): string[] {
  const trim = (s: string) => s.replace(/^[^\d\p{L}]+/u, '').replace(/[^\d\p{L}]+$/u, '')
  let w = trim(word)
  for (const symbol of symbols) {
    if (!symbol) continue
    if (w.startsWith(symbol)) w = w.slice(symbol.length)
    else if (w.endsWith(symbol)) w = w.slice(0, -symbol.length)
  }
  w = trim(w)
  if (!/^\d[\d.,]*$/.test(w)) return []
  const italian = w.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')
  const english = w.replace(/,(?=\d{3}(\D|$))/g, '')
  return [...new Set([italian, english])].filter((form) => /^\d+(\.\d+)?$/.test(form))
}

/** Una ricerca pronta per essere confrontata: ogni parola, e i modi di leggerla come importo. */
export type Query = { word: string; amounts: string[] }[]

/**
 * Le parole di quello che è stato scritto, senza maiuscole né accenti. Quelle fatte solo di segni si buttano:
 * un ":" o una virgola da soli non cercano niente. Si butta anche il simbolo della valuta scritto staccato
 * accanto a un importo ("431.984 L"): l'importo basta. Vuota se non resta nessuna parola.
 */
export function readQuery(text: string, symbols: string[] = []): Query {
  const words = fold(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => ({ word, amounts: amountForms(word, symbols) }))
  return words.filter(({ word }, i) => !(symbols.includes(word) && ((words[i - 1]?.amounts.length ?? 0) > 0 || (words[i + 1]?.amounts.length ?? 0) > 0)))
}

/**
 * Vero se un movimento contiene quello che si cerca. Ogni parola deve esserci, in qualunque ordine: nel testo
 * ("affitto marzo" trova "Affitto mese di marzo") oppure, se è un numero, come inizio di uno dei suoi importi
 * ("431" e "431.984" trovano 431984; "12" non trova tutto quello che è successo alle dodici).
 */
export function matches(haystack: Haystack, query: Query): boolean {
  return query.every(({ word, amounts }) => haystack.text.includes(word) || amounts.some((form) => haystack.amounts.some((amount) => amount.startsWith(form))))
}

// ——— I totali di una ricerca ———

export interface PeriodTotal {
  /** Primo istante dell'anno o del mese. */
  start: number
  out: number
  in: number
  count: number
}

export interface SearchTotals {
  /** Entrate e uscite già avvenute tra i risultati: sono quelle che fanno i totali. */
  count: number
  out: number
  outCount: number
  /** L'uscita tipica (mediana): una spesa enorme non la sposta. */
  outTypical: number
  in: number
  inCount: number
  inTypical: number
  /** Giroconti, soldi messi negli obiettivi o ripresi, saldi iniziali: spostano soldi, non sono né entrate né uscite. */
  moved: number
  /** Movimenti con una data futura: si vedono nell'elenco ma non sono ancora successi. */
  upcoming: number
  /** Il primo e l'ultimo giorno di quelli contati; null se non ce n'è nessuno. */
  first: number | null
  last: number | null
  /** Quanti mesi di calendario ci sono tra il primo e l'ultimo, compresi. */
  months: number
  /** Come sono divisi: per anno se i risultati toccano più anni, per mese se stanno in uno solo; null se è un mese solo. */
  by: 'year' | 'month' | null
  /** Dal più recente; solo gli anni o i mesi in cui c'è qualcosa. */
  periods: PeriodTotal[]
}

const middle = (values: number[]) => {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * Quanto è uscito e quanto è entrato tra i movimenti trovati, nella valuta principale. Contano solo entrate e uscite
 * già avvenute: un giroconto o dei soldi messi da parte non sono una spesa, e una scadenza futura non è ancora successa.
 */
export function searchTotals(list: Transaction[], now: number): SearchTotals {
  const outs: number[] = []
  const ins: number[] = []
  let moved = 0
  let upcoming = 0
  let first: number | null = null
  let last: number | null = null
  const counted: Transaction[] = []
  for (const tx of list) {
    if (tx.date > now) upcoming++
    else if (tx.kind === 'expense' || tx.kind === 'income') {
      ;(tx.kind === 'expense' ? outs : ins).push(tx.mainAmount)
      counted.push(tx)
      if (first === null || tx.date < first) first = tx.date
      if (last === null || tx.date > last) last = tx.date
    } else moved++
  }
  const a = new Date(first ?? 0)
  const b = new Date(last ?? 0)
  const months = first === null ? 0 : (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + 1
  const by = first === null || months < 2 ? null : a.getFullYear() !== b.getFullYear() ? 'year' : 'month'
  const groups = new Map<number, PeriodTotal>()
  if (by) {
    for (const tx of counted) {
      const d = new Date(tx.date)
      const start = new Date(d.getFullYear(), by === 'year' ? 0 : d.getMonth(), 1).getTime()
      const g = groups.get(start) ?? { start, out: 0, in: 0, count: 0 }
      if (tx.kind === 'expense') g.out += tx.mainAmount
      else g.in += tx.mainAmount
      g.count++
      groups.set(start, g)
    }
  }
  const sum = (values: number[]) => values.reduce((s, v) => s + v, 0)
  return {
    count: counted.length,
    out: sum(outs),
    outCount: outs.length,
    outTypical: middle(outs),
    in: sum(ins),
    inCount: ins.length,
    inTypical: middle(ins),
    moved,
    upcoming,
    first,
    last,
    months,
    by,
    periods: [...groups.values()].sort((x, y) => y.start - x.start),
  }
}
