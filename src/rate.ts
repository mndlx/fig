import type { Currency, Transaction } from './db'
import { decimalSep } from './i18n'
import { convertMinor, rateText, soundRate } from './money'

/**
 * Cambio di un movimento in valuta, come lo vede chi lo scrive (foglio "+", allineamento del saldo).
 * Solo funzioni pure: niente React, rete o database, così le regole si provano una per una.
 *
 * Non c'è uno stato "cambio nel campo" da tenere aggiornato a ogni scelta dell'utente: si ricordano solo
 * due FATTI, ognuno con la sua chiave, e quello che si mostra si ricava ogni volta da fatti e contesto.
 * - `typed`: il testo scritto a mano, per coppia di valute ("EUR>ALL");
 * - `fetched`: il cambio del giorno arrivato dal servizio, per coppia e giorno ("EUR>ALL@2026-10-07").
 * Un fatto non può finire sulla valuta sbagliata, quindi cambiando valuta non c'è niente da azzerare e
 * una risposta arrivata in ritardo non può comparire dove non c'entra.
 */

/** Da dove viene il cambio: scritto a mano, del movimento in modifica, del giorno, l'ultimo usato, nessuno. */
export type RateSource = 'typed' | 'own' | 'day' | 'last' | 'none'

/** Dove si sta guardando. Si ricalcola a ogni disegno: non è stato da tenere. */
export interface RateContext {
  /** Valuta effettiva del movimento (per i gomitoli è già la principale). */
  from: string
  /** Valuta principale. */
  to: string
  /** Giorno del movimento, aaaa-mm-gg locale. */
  day: string
  /** Movimento in modifica, solo se è scritto in `from`: il suo giorno e il suo cambio vero. */
  origin: { day: string; rate: number } | null
  /** Ultimo cambio usato per `from` e la data del movimento da cui viene. */
  last: { rate: number; at: number } | null
}

export interface RateFacts {
  /** "EUR>ALL" → testo così com'è stato scritto. */
  typed: Readonly<Record<string, string>>
  /** "EUR>ALL@2026-10-07" → cambio del giorno; null = il servizio non ce l'ha; assente = non ancora arrivato. */
  fetched: Readonly<Record<string, number | null>>
}

export const NO_RATES: RateFacts = { typed: {}, fetched: {} }

export interface RateView {
  /** La valuta del movimento non è la principale: il cambio serve e il campo si mostra. */
  foreign: boolean
  /** Testo del campo. */
  text: string
  /** Cambio da usare; null se manca o non si legge. 1 nella valuta principale. */
  value: number | null
  source: RateSource
  /** Cambio che si propone al posto di quello scritto: segnaposto del campo quando è vuoto. */
  proposal: { value: number; source: 'own' | 'day' | 'last' } | null
  /** Data del movimento da cui viene l'ultimo cambio usato, quando è quello che si mostra. */
  at: number | null
  /** Il cambio del giorno è stato chiesto e non è ancora arrivato. */
  pending: boolean
}

const good = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const blank = (text: string | undefined): boolean => text === undefined || text.trim() === ''
const pairOf = (c: Pick<RateContext, 'from' | 'to'>) => `${c.from}>${c.to}`
export const rateKey = (c: Pick<RateContext, 'from' | 'to' | 'day'>) => `${pairOf(c)}@${c.day}`

/** Giorno locale di un istante, come lo vuole un campo data: aaaa-mm-gg. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Ultimo istante di un giorno locale scritto come aaaa-mm-gg. */
export function dayEnd(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59).getTime()
}

/**
 * Cambio scritto a mano → numero, oppure null se non è un cambio: vuoto, illeggibile, zero o negativo.
 * A differenza degli importi (readTyped), un solo separatore è SEMPRE il decimale, in ogni lingua: "1.085"
 * è uno virgola zero ottantacinque, perché nessuno scrive le migliaia in un cambio e la tastiera dei numeri
 * dipende dal telefono, non dalla lingua dell'app. Con punto e virgola insieme l'ultimo è il decimale;
 * lo stesso separatore ripetuto può solo raggruppare le migliaia. Niente segni, lettere o esponenti.
 */
export function readRate(text: string): number | null {
  const v = text.replace(/[\s  ']/g, '')
  if (!/^[\d.,]+$/.test(v) || !/\d/.test(v)) return null
  const dots = v.split('.').length - 1
  const commas = v.split(',').length - 1
  const grouped = (s: string, sep: string) => new RegExp(`^[1-9]\\d{0,2}(\\${sep}\\d{3})+$`).test(s)
  let plain: string
  if (dots + commas <= 1) plain = v.replace(',', '.')
  else if (dots > 0 && commas > 0) {
    const dec = v.lastIndexOf('.') > v.lastIndexOf(',') ? '.' : ','
    const grp = dec === '.' ? ',' : '.'
    const parts = v.split(dec)
    if (parts.length !== 2 || !grouped(parts[0], grp) || !/^\d*$/.test(parts[1])) return null
    plain = `${parts[0].split(grp).join('')}.${parts[1]}`
  } else {
    const sep = dots > 0 ? '.' : ','
    if (!grouped(v, sep)) return null
    plain = v.split(sep).join('')
  }
  const n = Number(plain)
  return good(n) ? n : null
}

/** Cambio da mostrare in un campo: col separatore della lingua; vuoto se non è un cambio. */
export function rateInput(rate: number): string {
  return good(rate) ? rateText(rate).replace('.', decimalSep()) : ''
}

/**
 * Ultimo cambio usato per una valuta: quello vero (vedi soundRate) del movimento più vicino nel tempo a `when`,
 * a parità di distanza il più recente. Le scadenze generate dalle ricorrenze contano solo se non c'è altro:
 * ripetono il cambio del giorno in cui la serie è nata e possono avere una data futura. La prima di ogni serie
 * invece è il movimento scritto a mano quel giorno, col suo cambio: conta come gli altri.
 */
export function lastRate(transactions: readonly Transaction[], from: Currency, main: Currency, when: number): { rate: number; at: number } | null {
  if (from.code === main.code) return null
  const first = new Map<string, number>()
  for (const tx of transactions) if (tx.recurringId && tx.date < (first.get(tx.recurringId) ?? Infinity)) first.set(tx.recurringId, tx.date)
  let best: { series: boolean; gap: number; rate: number; at: number } | null = null
  for (const tx of transactions) {
    if (tx.currency !== from.code) continue
    const rate = soundRate(tx, from, main)
    if (!good(rate)) continue
    const series = !!tx.recurringId && tx.date !== first.get(tx.recurringId)
    const gap = Math.abs(tx.date - when)
    const better = !best || (best.series && !series) || (best.series === series && (gap < best.gap || (gap === best.gap && tx.date > best.at)))
    if (better) best = { series, gap, rate, at: tx.date }
  }
  return best ? { rate: best.rate, at: best.at } : null
}

/** Giorno e cambio vero del movimento in modifica, se è scritto in `from` e `from` non è la valuta principale. */
export function originOf(editing: Transaction | null | undefined, from: Currency, main: Currency): RateContext['origin'] {
  if (!editing || editing.currency !== from.code || from.code === main.code) return null
  return { day: dayKey(editing.date), rate: soundRate(editing, from, main) }
}

/** Cambio del movimento in modifica; null se non ne ha uno che si possa usare (zero, assente): vale come nuovo. */
const own = (c: RateContext) => (c.origin && good(c.origin.rate) ? c.origin.rate : null)
const atOrigin = (c: RateContext) => !!c.origin && c.origin.day === c.day

/**
 * Cambio da proporre, in ordine:
 * 1. in modifica, con valuta e giorno del movimento: il suo, e basta (modificare la nota non lo rivaluta);
 * 2. quello del giorno, se il servizio l'ha dato;
 * 3. in modifica con un altro giorno, se quello del giorno non c'è: ancora il suo, non quello di un altro movimento;
 * 4. l'ultimo usato per quella valuta.
 */
export function proposeRate(f: RateFacts, c: RateContext): RateView['proposal'] {
  if (c.from === c.to) return null
  const mine = own(c)
  if (mine !== null && atOrigin(c)) return { value: mine, source: 'own' }
  const day = f.fetched[rateKey(c)]
  if (good(day)) return { value: day, source: 'day' }
  if (mine !== null) return { value: mine, source: 'own' }
  if (c.last && good(c.last.rate)) return { value: c.last.rate, source: 'last' }
  return null
}

/**
 * C'è da chiedere il cambio del giorno? Non nella valuta principale, non se il cambio è scritto a mano, non
 * con valuta e giorno del movimento in modifica (vale il suo), non se la risposta per quel giorno c'è già.
 */
export function needsFetch(f: RateFacts, c: RateContext): boolean {
  if (c.from === c.to) return false
  if (!blank(f.typed[pairOf(c)])) return false
  if (atOrigin(c) && own(c) !== null) return false
  return f.fetched[rateKey(c)] === undefined
}

/** Quello che il campo mostra e il cambio che ne esce. */
export function rateView(f: RateFacts, c: RateContext): RateView {
  if (c.from === c.to) return { foreign: false, text: '', value: 1, source: 'none', proposal: null, at: null, pending: false }
  const proposal = proposeRate(f, c)
  const pending = needsFetch(f, c)
  const typed = f.typed[pairOf(c)]
  // Scritto a mano: vale quello, qualunque cosa arrivi dopo. Illeggibile: nessun cambio, non quello proposto.
  if (!blank(typed)) return { foreign: true, text: typed, value: readRate(typed), source: 'typed', proposal, at: null, pending }
  const at = proposal?.source === 'last' ? (c.last?.at ?? null) : null
  // Campo svuotato e non ancora lasciato: resta vuoto mentre si scrive, ma vale il cambio proposto (lo mostra il segnaposto).
  return { foreign: true, text: typed === undefined && proposal ? rateInput(proposal.value) : '', value: proposal?.value ?? null, source: proposal?.source ?? 'none', proposal, at, pending }
}

/** L'utente ha scritto nel campo. */
export function typeRate(f: RateFacts, c: RateContext, text: string): RateFacts {
  if (c.from === c.to) return f
  return { ...f, typed: { ...f.typed, [pairOf(c)]: text } }
}

/** Il campo è stato lasciato: quelli rimasti vuoti tornano a seguire il cambio proposto. */
export function leaveRate(f: RateFacts): RateFacts {
  const kept = Object.entries(f.typed).filter(([, text]) => !blank(text))
  return kept.length === Object.keys(f.typed).length ? f : { ...f, typed: Object.fromEntries(kept) }
}

/** È arrivata la risposta del servizio per una coppia e un giorno (null, zero o altro che non sia un cambio: non c'è). */
export function gotRate(f: RateFacts, key: string, value: number | null): RateFacts {
  // Un cambio arrivato non si perde per una risposta mancata dopo (richieste doppie).
  if (good(f.fetched[key])) return f
  return { ...f, fetched: { ...f.fetched, [key]: good(value) ? value : null } }
}

/**
 * Cambio e controvalore da salvare per un importo (col suo segno); null se il cambio manca.
 * In modifica, se importo, valuta e cambio sono quelli del movimento, restano com'erano al centesimo: rifare
 * il conto da un cambio riletto dal campo può spostarlo (100 $ a 92 salvati come 9.230 L tornerebbero 9.200),
 * e cambiare solo la nota non deve toccare i soldi. Il cambio che esce è quello vero: uno sbagliato di scala
 * delle versioni precedenti si corregge qui, senza muovere il controvalore.
 */
export function settle(
  amount: number,
  from: Currency,
  main: Currency,
  view: Pick<RateView, 'value' | 'source'>,
  editing?: Pick<Transaction, 'amount' | 'currency' | 'mainAmount'> | null,
): { rate: number; mainAmount: number } | null {
  if (from.code === main.code) return { rate: 1, mainAmount: amount }
  if (!good(view.value)) return null
  if (editing && view.source === 'own' && editing.currency === from.code && editing.amount === amount) return { rate: view.value, mainAmount: editing.mainAmount }
  // Segno a parte: si arrotonda il valore, poi si rimette il meno (-1,50 € a 97 fanno -146, non -145).
  return { rate: view.value, mainAmount: Math.sign(amount) * convertMinor(Math.abs(amount), from, main, view.value) }
}
