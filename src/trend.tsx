import type { Category, Currency, Transaction } from './db'
import { builtinName, dateFmt, locale, t, type Key } from './i18n'
import { formatMoney, moneyParts } from './money'
import { axisScale } from './stats'

/**
 * Le parti comuni ai riquadri della scheda "Andamento": come si scrivono cifre, date e nomi, la riga di un movimento
 * e il "Come si legge" sotto ogni grafico.
 */

/** Singolare quando serve: usa la chiave "x.one" se n è 1. */
export const tn = (key: Key, n: number, vars: Record<string, string | number> = {}) => t((n === 1 ? `${key}.one` : key) as Key, { n, ...vars })

/** Cifre, date e nomi come si scrivono nell'andamento, per la valuta principale e le categorie date. */
export function trendFormat(mainCurrency: Currency, categories: Category[]) {
  const unit = 10 ** mainCurrency.decimals
  const catById = new Map(categories.map((c) => [c.id, c]))
  // Lo spazio tra cifra e simbolo non va a capo: in una frase "2.077" e "L" non devono finire su due righe.
  const money = (v: number, sign = false) => formatMoney(v, mainCurrency, { sign }).replace(/ /g, ' ')
  /** La cifra senza il simbolo della valuta, per le tabelle: lì lo dice una riga sola, sotto. */
  const bare = (v: number, sign = false) => {
    const p = moneyParts(v, mainCurrency, { sign })
    return p.sign + p.whole + p.fraction
  }
  const short = (x: number, digits: number) => x.toLocaleString(locale(), { maximumFractionDigits: digits, useGrouping: 'always' })
  /** Un numero con al più una cifra decimale ("1,5"). */
  const num = (v: number) => short(v, 1)
  /** Cifra corta per le etichette: "200 mila", "1,2 mln". Le cifre esatte stanno nel testo accanto. */
  const compact = (v: number) => {
    const whole = Math.abs(v) / unit
    const sign = v < 0 ? '−' : ''
    if (whole >= 999_500) return sign + t('trend.m', { n: short(whole / 1_000_000, 1) })
    if (whole >= 10_000) return sign + t('trend.k', { n: short(whole / 1_000, 0) })
    return sign + short(whole, whole >= 100 ? 0 : 1)
  }
  /** Le scritte di un asse: stessa unità per tutte le tacche, coi decimali che servono al passo; lo zero è "0" e basta. */
  const axisLabels = (ticks: number[], step: number) => {
    const { div, decimals } = axisScale(ticks, step, unit)
    return ticks.map((v) => {
      if (v === 0) return '0'
      const n = short(Math.abs(v) / unit / div, decimals)
      return (v < 0 ? '−' : '') + (div === 1_000_000 ? t('trend.m', { n }) : div === 1_000 ? t('trend.k', { n }) : n)
    })
  }
  const clean = (s: string) => s.replace(/\./g, '')
  const monthLong = (ms: number) => dateFmt({ month: 'long', year: 'numeric' }).format(ms)
  // Con l'anno: "ott ’25". L'apostrofo serve: su un asse di giorni "ott 25" si leggerebbe come il 25 ottobre.
  const monthShort = (ms: number, withYear = false) => clean(dateFmt({ month: 'short' }).format(ms)) + (withYear ? ` ’${String(new Date(ms).getFullYear()).slice(2)}` : '')
  const monthYear = (ms: number) => clean(dateFmt({ month: 'short', year: 'numeric' }).format(ms))
  const dayShort = (ms: number) => clean(dateFmt({ day: 'numeric', month: 'short' }).format(ms))
  const dayLong = (ms: number) => clean(dateFmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(ms))
  const dayFull = (ms: number) => clean(dateFmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(ms))
  /** Giorno con l'anno a due cifre, per le liste di movimenti: i periodi passano da un anno all'altro. */
  const dayRow = (ms: number) => clean(dateFmt({ day: 'numeric', month: 'short', year: '2-digit' }).format(ms))
  const category = (id: string | undefined) => (id ? catById.get(id) : undefined)
  const catName = (id: string | undefined) => {
    const c = category(id)
    return c ? builtinName(c, 'cat') : t('thread.uncategorized')
  }
  /** Come si chiama un movimento: la sua nota fino a " · "; senza nota, quello che è. */
  const txName = (tx: Transaction) =>
    tx.note.split(' · ')[0].trim() ||
    (tx.kind === 'opening' ? t('thread.opening') : tx.kind === 'save' ? t('thread.saved') : tx.kind === 'release' ? t('thread.released') : tx.kind === 'income' && tx.source === 'adjust' ? t('trend.ev.adjust') : catName(tx.categoryId))
  return { unit, money, bare, num, compact, axisLabels, clean, monthLong, monthShort, monthYear, dayShort, dayLong, dayFull, dayRow, category, catName, txName }
}

export type TrendFormat = ReturnType<typeof trendFormat>

/** Un movimento in una lista: giorno, nome, importo. Si apre toccandolo. */
export function TxRow({ tx, fmt, onOpen }: { tx: Transaction; fmt: TrendFormat; onOpen: (tx: Transaction) => void }) {
  const out = tx.kind === 'expense' || tx.kind === 'save'
  return (
    <button className="cat-tx-row" onClick={() => onOpen(tx)}>
      <span className="cat-tx-date long">{fmt.dayRow(tx.date)}</span>
      <span className="grow">{fmt.txName(tx)}</span>
      <span className="legend-value">{fmt.money(out ? -tx.mainAmount : tx.mainAmount, !out)}</span>
    </button>
  )
}

/** "Come si legge": chiuso finché non serve, una riga per ogni cosa che il grafico mostra. */
export function HowTo({ items }: { items: string[] }) {
  return (
    <details className="howto">
      <summary>{t('trend.how')}</summary>
      <ul>
        {items.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    </details>
  )
}
