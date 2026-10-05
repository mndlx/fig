import type { Currency } from './db'
import { decimalSep, getLang, locale } from './i18n'

const FALLBACK: Currency = { code: 'EUR', symbol: '€', decimals: 2 }

/** Converte unità minime (es. centesimi) in un numero decimale. */
export function fromMinor(minor: number, decimals: number): number {
  return minor / 10 ** decimals
}

/** Converte la stringa del tastierino (decimali con "." o ",", senza migliaia) in unità minime. */
export function parseInput(input: string, decimals: number): number {
  if (!input) return 0
  const value = Number(input.replace(',', '.'))
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 10 ** decimals)
}

/**
 * Importo scritto a mano in un campo → unità minime, oppure null se non è un numero leggibile
 * ("abc", "12,3,4", un meno da solo). Accetta simboli e sigle attaccati ("€1500", "1.500 L").
 * Con punto e virgola insieme l'ultimo è il decimale; con un solo separatore seguito da tre cifre
 * decide la lingua ("1.500" è millecinquecento in italiano), ma nelle valute senza decimali è
 * sempre un separatore delle migliaia: "150.000" lek sono centocinquantamila in ogni lingua.
 */
export function readTyped(text: string, decimals: number): number | null {
  let v = text.replace(/[\s  ]/g, '').replace(/−/g, '-')
  // Il meno vale ovunque stia prima della prima cifra: "-5", "-€5", "€ -5".
  const lead = v.match(/^[^\d]*/)?.[0] ?? ''
  const negative = lead.includes('-')
  v = v.slice(lead.length).replace(/[^\d]+$/, '')
  // ",50" e ".5" sono mezzi, non interi, anche dopo un simbolo ("CHF .50", "EUR,50"): il separatore in testa
  // conta. Non quando è il punto di una sigla, attaccato alle sue lettere ("Fr. 20", "L. 1500").
  const abbreviation = /\p{L}\.\s*$/u.test(text.match(/^[^\d]*/)?.[0] ?? '')
  if (/[.,]$/.test(lead) && !abbreviation) {
    if (decimals === 0 || !/^\d+$/.test(v)) return null
    return (negative ? -1 : 1) * Math.round(Number(`0.${v}`) * 10 ** decimals)
  }
  if (!/^\d[\d.,]*$/.test(v)) return null
  const dots = v.split('.').length - 1
  const commas = v.split(',').length - 1
  // Le migliaia non cominciano con zero: "0.500" è mezzo, non cinquecento.
  const grouped = (s: string, sep: string) => new RegExp(`^[1-9]\\d{0,2}(\\${sep}\\d{3})+$`).test(s)
  let plain: string
  if (dots === 0 && commas === 0) plain = v
  else if (dots > 0 && commas > 0) {
    const dec = v.lastIndexOf('.') > v.lastIndexOf(',') ? '.' : ','
    const grp = dec === '.' ? ',' : '.'
    const parts = v.split(dec)
    if (parts.length !== 2 || !grouped(parts[0], grp) || !/^\d+$/.test(parts[1])) return null
    plain = `${parts[0].split(grp).join('')}.${parts[1]}`
  } else {
    const sep = dots > 0 ? '.' : ','
    if (dots + commas > 1) {
      // Lo stesso separatore più volte può solo raggruppare le migliaia.
      if (!grouped(v, sep)) return null
      plain = v.split(sep).join('')
    } else {
      const thousands = grouped(v, sep) && (decimals === 0 || sep === (getLang() === 'it' ? '.' : ','))
      plain = thousands ? v.replace(sep, '') : v.replace(sep, '.')
    }
  }
  const n = Number(plain)
  if (!Number.isFinite(n)) return null
  return (negative ? -1 : 1) * Math.round(n * 10 ** decimals)
}

/** Come readTyped, ma un testo illeggibile vale zero (per i campi dove vuoto e zero sono la stessa cosa). */
export function parseTyped(text: string, decimals: number): number {
  return readTyped(text, decimals) ?? 0
}

export interface MoneyParts {
  sign: string
  whole: string
  /** Parte decimale con il separatore, es. ",50"; vuota se l'importo è intero. */
  fraction: string
  symbol: string
  /** In inglese il simbolo va prima ("€12.50"), in italiano dopo ("12,50 €"). */
  symbolFirst: boolean
}

export function moneyParts(minor: number, currency: Currency = FALLBACK, opts: { sign?: boolean } = {}): MoneyParts {
  const value = fromMinor(Math.abs(minor), currency.decimals)
  const body = value.toLocaleString(locale(), {
    minimumFractionDigits: value % 1 === 0 ? 0 : currency.decimals,
    maximumFractionDigits: currency.decimals,
    // In italiano Intl non separa le migliaia sotto 10.000: forziamo "1.213".
    useGrouping: 'always',
  })
  const sep = decimalSep()
  const cut = currency.decimals > 0 ? body.lastIndexOf(sep) : -1
  return {
    sign: minor < 0 ? '−' : opts.sign && minor > 0 ? '+' : '',
    whole: cut >= 0 ? body.slice(0, cut) : body,
    fraction: cut >= 0 ? body.slice(cut) : '',
    symbol: currency.symbol,
    symbolFirst: getLang() === 'en',
  }
}

export function formatMoney(minor: number, currency: Currency = FALLBACK, opts: { sign?: boolean } = {}): string {
  const p = moneyParts(minor, currency, opts)
  if (p.symbolFirst) return `${p.sign}${p.symbol}${p.symbol.length > 1 ? ' ' : ''}${p.whole}${p.fraction}`
  return `${p.sign}${p.whole}${p.fraction} ${p.symbol}`
}

/** Converte un importo tra valute usando il tasso "1 unità di from = rate unità di to". */
export function convertMinor(amount: number, from: Currency, to: Currency, rate: number): number {
  return Math.round(fromMinor(amount, from.decimals) * rate * 10 ** to.decimals)
}

/** Tasso BCE (via Frankfurter) del giorno indicato; null se non disponibile, es. offline. */
export async function fetchRate(from: string, to: string, date: Date): Promise<number | null> {
  if (from === to) return 1
  const day = date.toISOString().slice(0, 10)
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${day}?from=${from}&to=${to}`)
    if (!res.ok) return null
    const data: { rates?: Record<string, number> } = await res.json()
    return data.rates?.[to] ?? null
  } catch {
    return null
  }
}
