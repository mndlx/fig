import type { Currency, Transaction } from './db'
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

/**
 * Cambio che lega davvero i due importi di un movimento: quante unità della valuta principale vale 1 unità
 * della valuta del movimento. Si calcola sulle cifre vere, non sulle unità minime: 100,00 $ che valgono
 * 9.200 L danno 92, non 0,92. Null se uno dei due importi è zero (non c'è niente da cui ricavarlo).
 */
export function impliedRate(amount: number, from: Currency, mainAmount: number, main: Currency): number | null {
  if (!amount || !mainAmount) return null
  return Math.abs(fromMinor(mainAmount, main.decimals)) / Math.abs(fromMinor(amount, from.decimals))
}

/**
 * Cambio di un movimento da usare nei calcoli: quello salvato, se torna coi suoi importi; altrimenti quello che
 * gli importi implicano. Serve per i saldi iniziali dei conti in valuta salvati dalle versioni precedenti, il cui
 * cambio era ricavato dalle unità minime: sbagliato di 10, 100 o 1000 volte quando le due valute hanno un numero
 * diverso di decimali (il controvalore invece era giusto). Usarlo così com'è per rifare un conto lo sbaglierebbe
 * della stessa misura.
 *
 * Limite: si riconosce solo un cambio che non torna col suo controvalore. Un movimento il cui controvalore era
 * già stato rifatto col cambio sbagliato (modificato o allineato con le versioni precedenti) è coerente con sé
 * stesso e passa per buono: lì l'errore si vede a schermo (100 $ che valgono 92 L) e si corregge a mano.
 */
export function soundRate(tx: Pick<Transaction, 'amount' | 'mainAmount' | 'rate' | 'currency'>, from: Currency, main: Currency): number {
  if (tx.currency === main.code) return 1
  const implied = impliedRate(tx.amount, from, tx.mainAmount, main)
  // Niente da cui ricavarlo: resta quello salvato, o zero se non è nemmeno un numero (dati arrivati da fuori).
  if (implied === null) return Number.isFinite(tx.rate) ? tx.rate : 0
  if (!(tx.rate > 0)) return implied
  // Il cambio salvato "torna" se rifacendo il conto si ritrova il controvalore, a meno degli arrotondamenti
  // (un'unità minima, o poco più sugli importi grandi). Un errore di scala sbaglia di almeno dieci volte.
  const expected = convertMinor(Math.abs(tx.amount), from, main, tx.rate)
  const actual = Math.abs(tx.mainAmount)
  // Un conto che dà zero non conferma niente: con un controvalore di una sola unità minima rientrerebbe nella tolleranza.
  return expected > 0 && Math.abs(expected - actual) <= Math.max(1, actual * 0.02) ? tx.rate : implied
}

/**
 * Un cambio come testo: al più dieci cifre significative, senza le code dei calcoli in virgola mobile e senza
 * esponente (i numeri piccolissimi verrebbero "9.5e-7", che in un campo non si legge né si riscrive).
 */
export function rateText(rate: number): string {
  const text = String(Number(rate.toPrecision(10)))
  if (!/e-/.test(text)) return text
  const decimals = Math.min(100, Math.ceil(-Math.log10(Math.abs(Number(text)))) + 9)
  return Number(text).toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Un movimento dopo il cambio della valuta principale (`x` = quante unità della nuova vale 1 unità della vecchia).
 * Importo e valuta restano quelli scritti, per ogni tipo di movimento: cambiano solo controvalore e cambio.
 * Così tornando alla valuta di prima si ritrovano le cifre esatte, senza gli arrotondamenti di due conversioni.
 * - Già nella nuova valuta principale: il controvalore è l'importo stesso.
 * - Gli altri: cambio del movimento (quello vero, vedi soundRate) per `x`, col segno tenuto a parte come
 *   quando il movimento viene scritto.
 * Messi da parte e ripresi restano quindi scritti nella valuta di prima: chi li mostra come cifra della valuta
 * principale deve leggerne il controvalore (lo fa il foglio "+", che salvando li riscrive in quella nuova).
 */
export function rebaseTransaction(tx: Transaction, from: Currency, oldMain: Currency, target: Currency, x: number): Transaction {
  if (tx.currency === target.code) return { ...tx, rate: 1, mainAmount: tx.amount }
  const rate = soundRate(tx, from, oldMain) * x
  return { ...tx, rate, mainAmount: Math.sign(tx.amount) * convertMinor(Math.abs(tx.amount), from, target, rate) }
}

/**
 * Tasso BCE (via Frankfurter) del giorno indicato; null se non disponibile: offline, coppia non pubblicata,
 * o nessuna risposta entro `timeout` millisecondi.
 */
export async function fetchRate(from: string, to: string, date: Date, timeout = 8000): Promise<number | null> {
  if (from === to) return 1
  const day = date.toISOString().slice(0, 10)
  try {
    // Con una rete che non risponde non si aspetta all'infinito: dopo qualche secondo vale "non disponibile".
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined
    const res = await fetch(`https://api.frankfurter.dev/v1/${day}?from=${from}&to=${to}`, { signal })
    if (!res.ok) return null
    const data: { rates?: Record<string, number> } = await res.json()
    return data.rates?.[to] ?? null
  } catch {
    return null
  }
}
