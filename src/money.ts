import type { Currency } from './db'
import { decimalSep, getLang, locale, parseLocaleNumber } from './i18n'

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

/** Da un numero scritto dall'utente in un campo (con migliaia e decimali della lingua) a unità minime. */
export function parseTyped(text: string, decimals: number): number {
  const negative = text.trim().startsWith('-')
  const value = parseLocaleNumber(text.replace('-', ''))
  return (negative ? -1 : 1) * Math.round(value * 10 ** decimals)
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
