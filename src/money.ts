import type { Currency, Recurring, Transaction } from './db'
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
 * Cambio "tondo" che lega due cifre: tra quelli che rifanno esattamente la cifra arrotondata, quello con meno
 * cifre. 1,50 € che valgono 146 L sono a 97 (145,5 arrotondato), non a 97,333; 5.000 L che sono 51,28 € a 97,5,
 * non a 97,5039. `toward` dice quale delle due cifre si ricava dall'altra: il controvalore dall'importo ('main')
 * o l'importo dal controvalore ('amount'). Null se una delle due è zero.
 */
export function simplestRate(amount: number, from: Currency, mainAmount: number, main: Currency, toward: 'main' | 'amount' = 'main'): number | null {
  const implied = impliedRate(amount, from, mainAmount, main)
  if (implied === null) return null
  const fits = (rate: number) =>
    toward === 'main' ? convertMinor(Math.abs(amount), from, main, rate) === Math.abs(mainAmount) : convertMinor(Math.abs(mainAmount), main, from, 1 / rate) === Math.abs(amount)
  for (let digits = 1; digits <= 10; digits++) {
    const rate = Number(implied.toPrecision(digits))
    if (rate > 0 && fits(rate)) return rate
  }
  return implied
}

/** Il conto di partenza di un movimento, o quello di arrivo di un giroconto. */
export type Side = 'from' | 'to'

type Sided = Pick<Transaction, 'amount' | 'currency' | 'mainAmount' | 'accountAmount' | 'toAccountAmount'>

/**
 * Un movimento ha un solo importo, nella sua valuta, ma tocca conti che possono essere in un'altra. Quanto sposta
 * su un conto, nella valuta di quel conto, si legge così:
 * - conto nella valuta del movimento: l'importo;
 * - conto nella valuta principale: il controvalore;
 * - né l'una né l'altra: va salvato a parte (accountAmount / toAccountAmount). Qui dice se serve.
 */
export function sideNeedsOwn(txCurrency: string, accountCurrency: string, mainCode: string): boolean {
  return accountCurrency !== txCurrency && accountCurrency !== mainCode
}

/**
 * Importo che il movimento sposta su un conto, nella valuta del conto (col segno di `amount`). Null se non lo si sa:
 * il conto non è né nella valuta del movimento né nella principale e l'importo a parte non c'è (movimenti scritti
 * prima che esistesse).
 */
export function sideAmount(tx: Sided, side: Side, accountCurrency: string, mainCode: string): number | null {
  if (accountCurrency === tx.currency) return tx.amount
  if (accountCurrency === mainCode) return tx.mainAmount
  const own = side === 'from' ? tx.accountAmount : tx.toAccountAmount
  return typeof own === 'number' && Number.isFinite(own) ? own : null
}

/**
 * Mette (numero) o toglie (null) gli importi sui conti, senza lasciare chiavi vuote: una riga uguale deve restare
 * uguale. Undefined lascia quello che c'è: di quel conto non si sa la valuta, quindi non si sa se la cifra serve.
 */
function withSides<T extends { accountAmount?: number; toAccountAmount?: number }>(row: T, from: number | null | undefined, to: number | null | undefined): T {
  const next = { ...row }
  if (typeof from === 'number') next.accountAmount = from
  else if (from === null) delete next.accountAmount
  if (typeof to === 'number') next.toAccountAmount = to
  else if (to === null) delete next.toAccountAmount
  return next
}

/**
 * Un movimento dopo il cambio della valuta principale (`x` = quante unità della nuova vale 1 unità della vecchia).
 * Importo e valuta restano quelli scritti, per ogni tipo di movimento: cambiano solo controvalore e cambio.
 * Così tornando alla valuta di prima si ritrovano le cifre esatte, senza gli arrotondamenti di due conversioni:
 * importo, controvalore e importi sui conti dei movimenti che toccano un conto in quella valuta tornano identici.
 * Il cambio no, non sempre: all'andata diventa 1 (o cambio × x) e al ritorno si ricava dalle cifre, quindi può
 * differire da quello scritto nelle ultime cifre (97,4 al posto di 97,35), pur rifacendo lo stesso controvalore.
 * Un movimento in una terza valuta che non tocca conti nella valuta di ritorno segue il cambio dato, come sempre.
 * - Già nella nuova valuta principale: il controvalore è l'importo stesso.
 * - Gli altri: cambio del movimento (quello vero, vedi soundRate) per `x`, col segno tenuto a parte come
 *   quando il movimento viene scritto.
 * Messi da parte e ripresi restano quindi scritti nella valuta di prima: chi li mostra come cifra della valuta
 * principale deve leggerne il controvalore (lo fa il foglio "+", che salvando li riscrive in quella nuova).
 *
 * `sides` dice in che valuta sono i conti toccati dal movimento. Quello che è passato su ogni conto non deve
 * cambiare, ma dove sta scritto sì: prima del cambio poteva essere il controvalore (conto nella vecchia valuta
 * principale), dopo va salvato a parte; e viceversa un conto nella nuova valuta principale lo trova nel
 * controvalore, che quindi diventa esattamente quella cifra (non importo × cambio). Si spostano solo cifre vere:
 * dove l'importo sul conto non si sa (movimenti scritti prima che esistesse) resta da stimare, non si inventa.
 *
 * Conseguenza voluta: un gomitolo riempito e poi speso da un conto in un'altra valuta può restare con qualche
 * centesimo dopo il cambio (il messo da parte passa col cambio dato, la spesa vale quello che è uscito dal conto).
 */
export function rebaseTransaction<T extends Sided & Pick<Transaction, 'rate'>>(tx: T, from: Currency, oldMain: Currency, target: Currency, x: number, sides: { from?: string; to?: string } = {}): T {
  // Quanto passava su ogni conto, letto prima di toccare il controvalore.
  const was = {
    from: sides.from ? sideAmount(tx, 'from', sides.from, oldMain.code) : null,
    to: sides.to ? sideAmount(tx, 'to', sides.to, oldMain.code) : null,
  }
  // Dopo: a parte solo se il conto non è né nella valuta del movimento né nella nuova principale. Di un conto che
  // non si conosce (cancellato altrove, per esempio) non si tocca niente.
  const kept = (side: Side) => (sides[side] ? (sideNeedsOwn(tx.currency, sides[side], target.code) ? was[side] : null) : undefined)
  if (tx.currency === target.code) return withSides({ ...tx, rate: 1, mainAmount: tx.amount }, kept('from'), kept('to'))
  // Un conto nella nuova valuta principale: il controvalore è quello che è passato lì.
  const inTarget = sides.from === target.code && was.from !== null ? was.from : sides.to === target.code && was.to !== null ? was.to : null
  if (inTarget !== null && inTarget !== 0 && tx.amount !== 0) {
    const mainAmount = Math.sign(tx.amount) * Math.abs(inTarget)
    // Il cambio: quello che verrebbe dal conto normale, se rifà proprio quella cifra; altrimenti il più semplice che la rifà.
    const carried = soundRate(tx, from, oldMain) * x
    const rate = carried > 0 && convertMinor(Math.abs(tx.amount), from, target, carried) === Math.abs(mainAmount) ? carried : (simplestRate(tx.amount, from, mainAmount, target) ?? carried)
    return withSides({ ...tx, rate, mainAmount }, kept('from'), kept('to'))
  }
  const rate = soundRate(tx, from, oldMain) * x
  return withSides({ ...tx, rate, mainAmount: Math.sign(tx.amount) * convertMinor(Math.abs(tx.amount), from, target, rate) }, kept('from'), kept('to'))
}

/**
 * Una ricorrenza dopo il cambio della valuta principale. Come i movimenti; gli accantonamenti automatici invece
 * sono cifre nella valuta principale e passano alla nuova (`x` come sopra).
 */
export function rebaseRule(rule: Recurring, from: Currency, oldMain: Currency, target: Currency, x: number, accountCurrency?: string): Recurring {
  if (rule.kind === 'save' && rule.currency !== target.code) {
    const value = convertMinor(rule.currency === oldMain.code ? rule.amount : rule.mainAmount, oldMain, target, x)
    return withSides({ ...rule, currency: target.code, rate: 1, amount: value, mainAmount: value }, null, null)
  }
  // Gli accantonamenti non spostano soldi tra conti: niente importi sul conto.
  return rule.kind === 'save' ? withSides(rebaseTransaction(rule, from, oldMain, target, x), null, null) : rebaseTransaction(rule, from, oldMain, target, x, { from: accountCurrency })
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
