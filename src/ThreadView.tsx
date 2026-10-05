import { IconChevronDown, IconChevronsDown, IconChevronsUp, IconInfoCircle, IconSearch, IconX } from '@tabler/icons-react'
import type { ForecastInfo } from './App'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { CategoryIcon } from './catIcons'
import { signedMain } from './data'
import type { Account, Category, Currency, Goal, Transaction } from './db'
import { builtinName, dateFmt, t } from './i18n'
import { FIG_BODY } from './Goals'
import { formatMoney } from './money'

/**
 * Il ramo del mese, dal più recente in alto all'inizio del mese in basso.
 * Sul ramo: foglie per le uscite (colore della categoria), gemme per le entrate, fichi per
 * i soldi messi da parte o ripresi. Lo spessore segue il disponibile, ma è solo un indizio
 * secondario: il saldo si legge sempre dai numeri.
 * I giorni passati da più di un giorno sono compattati in una riga che si apre con un tocco.
 */

const LANE = 64
const ROW = { start: 56, day: 38, tx: 60, summary: 60, forecast: 64 }

type Row =
  | { type: 'forecast'; to: number; from: number }
  | { type: 'day'; key: string; date: Date; balance: number; spent: number; upcoming: boolean }
  | { type: 'tx'; tx: Transaction; before: number; after: number }
  | { type: 'summary'; key: string; date: Date; txs: Transaction[]; before: number; after: number; spent: number }
  | { type: 'start'; balance: number }

interface Props {
  startBalance: number
  monthTx: Transaction[]
  forecast: number | null
  forecastInfo?: ForecastInfo | null
  mainCurrency: Currency
  currencies: Currency[]
  categories: Category[]
  accounts: Account[]
  goals: Goal[]
  freshId: string | null
  onOpen: (tx: Transaction) => void
}

/** Ascissa del filo in funzione della quota verticale: un'ondulazione lenta e continua. */
function xAt(y: number): number {
  return LANE / 2 + 9 * Math.sin(y / 70) + 3 * Math.sin(y / 23)
}

function pathBetween(y0: number, y1: number, offset: number): string {
  const step = 4
  let d = `M ${xAt(offset + y0).toFixed(2)} ${y0}`
  for (let y = y0 + step; y < y1; y += step) d += ` L ${xAt(offset + y).toFixed(2)} ${y}`
  d += ` L ${xAt(offset + y1).toFixed(2)} ${y1}`
  return d
}

const dayFormat = () => dateFmt({ weekday: 'long', day: 'numeric', month: 'long' })
const shortDay = () => dateFmt({ weekday: 'short', day: 'numeric' })
const timeFormat = () => dateFmt({ hour: '2-digit', minute: '2-digit' })

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Giorni aperti o chiusi a mano, ricordati su questo dispositivo (true = aperto). */
const DAYS_KEY = 'fig-days'
function loadDays(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(DAYS_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}
function storeDays(days: Record<string, boolean>) {
  try {
    // Si tengono solo gli ultimi giorni toccati, la memoria non cresce all'infinito.
    const entries = Object.entries(days).slice(-400)
    localStorage.setItem(DAYS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Memoria non disponibile: i giorni tornano alla disposizione predefinita.
  }
}

function sameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b)
}

function dayLabel(d: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (sameDay(d, today)) return t('common.today')
  if (sameDay(d, yesterday)) return t('common.yesterday')
  return dayFormat().format(d)
}

const rim = (color: string) => `color-mix(in srgb, ${color} 55%, var(--ink))`

/** Piccolo fico appeso al ramo, per i soldi messi da parte o ripresi. */
function FigKnot({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  const s = size / 30
  return (
    <g className="knot" transform={`translate(${x - 15 * s} ${y - 14 * s}) scale(${s})`}>
      <path d={FIG_BODY} fill={color} stroke={rim(color)} strokeWidth={1.4 / s} />
      <path d="M15 5.5L15.8 2" stroke="var(--leaf)" strokeWidth={2} strokeLinecap="round" />
      <path d="M15.6 3.2C17.5 1 20.5 0.8 22 2.2C20.2 4 17.6 4.2 15.6 3.2Z" fill="var(--leaf)" />
    </g>
  )
}

/** Foglia che parte dal ramo verso sinistra o destra; la lunghezza cresce con l'importo. */
function Leaf({ x, y, length, side, color, ring }: { x: number; y: number; length: number; side: 1 | -1; color: string; ring?: string }) {
  const L = length * side
  const w = length * 0.42
  const d = `M ${x} ${y} C ${x + L * 0.25} ${y - w}, ${x + L * 0.75} ${y - w * 0.9}, ${x + L} ${y - length * 0.18} C ${x + L * 0.72} ${y + w * 0.75}, ${x + L * 0.25} ${y + w * 0.7}, ${x} ${y} Z`
  return (
    <g className="knot">
      <path d={d} fill={color} stroke={ring ?? rim(color)} strokeWidth={ring ? 1.8 : 1} strokeLinejoin="round" />
      <path d={`M ${x} ${y} Q ${x + L * 0.5} ${y - w * 0.12} ${x + L * 0.9} ${y - length * 0.17}`} stroke="var(--bg)" strokeOpacity={0.55} strokeWidth={0.9} fill="none" />
    </g>
  )
}

/** Gemma sul ramo, per le entrate: un bocciolo con un germoglio. */
function Bud({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return (
    <g className="knot">
      <circle cx={x} cy={y} r={r} fill={color} stroke={rim(color)} strokeWidth={1.2} />
      <path d={`M ${x + r * 0.2} ${y - r * 0.9} C ${x + r * 0.6} ${y - r * 2}, ${x + r * 1.6} ${y - r * 2.1}, ${x + r * 2} ${y - r * 1.7} C ${x + r * 1.5} ${y - r * 1.1}, ${x + r * 0.7} ${y - r * 1}, ${x + r * 0.2} ${y - r * 0.9} Z`} fill="var(--leaf)" />
    </g>
  )
}

export function ThreadView(props: Props) {
  const { startBalance, monthTx, forecast, forecastInfo, mainCurrency, currencies, categories, accounts, goals, freshId } = props
  const [dayState, setDayState] = useState<Record<string, boolean>>(loadDays)
  const [infoOpen, setInfoOpen] = useState(false)
  // Movimento appena salvato il cui giorno è stato richiuso a mano: da lì in poi non si riapre da solo.
  const [freshDismissed, setFreshDismissed] = useState<string | null>(null)
  // La spiegazione della previsione si chiude toccando altrove.
  useEffect(() => {
    if (!infoOpen) return
    const close = () => setInfoOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [infoOpen])
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const accById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const curByCode = useMemo(() => new Map(currencies.map((c) => [c.code, c])), [currencies])
  const goalById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals])
  const mainAccountId = accounts.find((a) => !a.archived)?.id
  const accName = (id?: string) => {
    const a = id ? accById.get(id) : undefined
    return a ? builtinName(a, 'acc') : '?'
  }

  // Il giorno del movimento appena salvato si apre da solo.
  const freshDay = useMemo(() => {
    const tx = freshId ? monthTx.find((x) => x.id === freshId) : undefined
    return tx ? dayKey(new Date(tx.date)) : null
  }, [freshId, monthTx])

  const rows = useMemo(() => {
    const now = new Date()
    const recent = new Set([dayKey(now), dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))])

    // Saldi in ordine cronologico, poi gruppi per giorno.
    type Day = { key: string; date: Date; items: { tx: Transaction; before: number; after: number }[]; start: number; end: number; spent: number }
    const days: Day[] = []
    let running = startBalance
    for (const tx of monthTx) {
      const d = new Date(tx.date)
      const key = dayKey(d)
      let day = days[days.length - 1]
      if (!day || day.key !== key) {
        day = { key, date: d, items: [], start: running, end: running, spent: 0 }
        days.push(day)
      }
      const delta = signedMain(tx)
      day.items.push({ tx, before: running, after: running + delta })
      running += delta
      day.end = running
      if (tx.kind === 'expense') day.spent += tx.mainAmount
    }

    // Dal più recente: previsione, giorni (aperti o compattati), inizio mese.
    // Di base sono aperti oggi, ieri, i giorni futuri e quelli con un solo movimento;
    // una scelta fatta a mano (o con "Espandi/Comprimi tutto") vale finché non la si cambia.
    const out: Row[] = []
    if (forecast !== null) out.push({ type: 'forecast', to: forecast, from: running })
    for (const day of [...days].reverse()) {
      const upcoming = day.date.getTime() > now.getTime() && !recent.has(day.key)
      const byDefault = upcoming || recent.has(day.key) || day.items.length === 1
      // Il giorno del movimento appena salvato si apre da solo, finché non lo si richiude.
      const showFresh = day.key === freshDay && freshDismissed !== freshId
      const open = showFresh || (dayState[day.key] ?? byDefault)
      if (open) {
        out.push({ type: 'day', key: day.key, date: day.date, balance: day.end, spent: day.spent, upcoming })
        for (const item of [...day.items].reverse()) out.push({ type: 'tx', ...item })
      } else {
        out.push({ type: 'summary', key: day.key, date: day.date, txs: day.items.map((i) => i.tx), before: day.start, after: day.end, spent: day.spent })
      }
    }
    out.push({ type: 'start', balance: startBalance })
    return out
  }, [startBalance, monthTx, forecast, dayState, freshDay, freshDismissed, freshId])

  // Riferimento per lo spessore: il saldo più alto toccato nel mese.
  const ref = useMemo(() => {
    let max = Math.max(startBalance, 1)
    for (const r of rows) if (r.type === 'tx' || r.type === 'summary') max = Math.max(max, r.before, r.after)
    return max
  }, [rows, startBalance])
  const maxAmount = useMemo(() => Math.max(1, ...monthTx.map((tx) => tx.mainAmount)), [monthTx])

  const width = (balance: number) => (balance <= 0 ? 1.5 : 2 + 3.5 * Math.min(1, balance / ref))
  const tone = (balance: number) => (balance < 0 ? 'var(--danger)' : 'var(--branch)')

  // Dopo un salvataggio porta in vista il nodo appena annodato.
  useEffect(() => {
    if (freshId) document.querySelector('.row-tx.fresh')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [freshId, monthTx.length])

  function setDays(update: (prev: Record<string, boolean>) => Record<string, boolean>) {
    setDayState((prev) => {
      const next = update(prev)
      storeDays(next)
      return next
    })
  }

  /** Apre o chiude un giorno, partendo da come è mostrato adesso. */
  function toggle(key: string, openNow: boolean) {
    if (openNow && key === freshDay) setFreshDismissed(freshId)
    setDays((prev) => {
      const next = { ...prev }
      delete next[key]
      next[key] = !openNow
      return next
    })
  }

  const monthDays = useMemo(() => [...new Set(monthTx.map((tx) => dayKey(new Date(tx.date))))], [monthTx])
  const allOpen = rows.filter((r) => r.type === 'summary').length === 0
  const allClosed = !rows.some((r) => r.type === 'day')
  function setAll(open: boolean) {
    if (!open) setFreshDismissed(freshId)
    setDays((prev) => {
      const next = { ...prev }
      for (const key of monthDays) {
        delete next[key]
        next[key] = open
      }
      return next
    })
  }

  /** Icona di un movimento: la categoria, oppure il tipo per gomitoli, giroconti e saldi iniziali. */
  function iconOf(tx: Transaction, catIcon?: string): string {
    if (catIcon) return catIcon
    if (tx.kind === 'save' || tx.kind === 'release') return 'piggy'
    if (tx.kind === 'transfer') return 'wallet'
    if (tx.kind === 'opening') return 'bank'
    return 'dots'
  }

  /** Titolo, dettagli e importo di un movimento, come si leggono nel filo e nella ricerca. */
  function describe(tx: Transaction) {
    const cat = tx.categoryId ? catById.get(tx.categoryId) : undefined
    const goal = tx.goalId ? goalById.get(tx.goalId) : undefined
    const cur = curByCode.get(tx.currency) ?? mainCurrency
    const otherAccount = tx.accountId !== mainAccountId ? accName(tx.accountId) : null
    let title: string
    let meta: (string | null | undefined)[]
    let amount: string
    let tone = ''
    switch (tx.kind) {
      case 'opening':
        title = t('thread.opening')
        meta = [accName(tx.accountId), tx.note]
        amount = formatMoney(tx.amount, cur)
        break
      case 'transfer':
        title = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`
        meta = [t('thread.transfer'), tx.note]
        amount = formatMoney(tx.amount, cur)
        tone = 'muted'
        break
      case 'save':
        title = goal?.name ?? t('thread.stash')
        meta = [t('thread.saved'), tx.note]
        amount = formatMoney(-tx.amount, cur)
        break
      case 'release':
        title = goal?.name ?? t('thread.stash')
        meta = [t('thread.released'), tx.note]
        amount = formatMoney(tx.amount, cur, { sign: true })
        tone = 'positive'
        break
      default: {
        const catName = cat ? builtinName(cat, 'cat') : t('thread.uncategorized')
        // Con una nota ("Netflix", "Affitto") il titolo è la nota e la categoria va nei dettagli.
        title = tx.note || catName
        meta = [tx.note ? catName : null, goal ? t('thread.fromGoal', { goal: goal.name }) : null, otherAccount]
        amount = formatMoney(tx.kind === 'income' ? tx.amount : -tx.amount, cur, { sign: true })
        if (tx.kind === 'income') tone = 'positive'
        if (goal) tone = 'from-goal'
      }
    }
    const upcoming = tx.date > Date.now()
    const metaText = [upcoming ? t('thread.upcoming') : null, tx.recurringId ? '↻' : null, ...meta, timeFormat().format(tx.date)].filter(Boolean).join(' · ')
    const converted = tx.currency !== mainCurrency.code && tx.kind !== 'transfer' ? formatMoney(tx.kind === 'income' ? tx.mainAmount : -tx.mainAmount, mainCurrency) : null
    return { title, metaText, amount, tone, converted, cat, goal, upcoming }
  }

  // ——— Ricerca: elenco semplice dei movimenti del mese che corrispondono ———
  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    if (!q) return []
    return [...monthTx].reverse().filter((tx) => {
      const d = describe(tx)
      const amountText = (tx.mainAmount / 10 ** mainCurrency.decimals).toFixed(mainCurrency.decimals)
      return (
        d.title.toLowerCase().includes(q) ||
        d.metaText.toLowerCase().includes(q) ||
        accName(tx.accountId).toLowerCase().includes(q) ||
        amountText.includes(q.replace(',', '.'))
      )
    })
  }, [q, monthTx, categories, goals, accounts])

  const searchBar = (
    <div className={`thread-search${searching ? ' open' : ''}`}>
      {!searching && monthDays.length > 1 && (
        <span className="fold-all">
          <button disabled={allOpen} onClick={() => setAll(true)}>
            <IconChevronsDown size={15} />
            {t('thread.expandAll')}
          </button>
          <button disabled={allClosed} onClick={() => setAll(false)}>
            <IconChevronsUp size={15} />
            {t('thread.collapseAll')}
          </button>
        </span>
      )}
      {searching ? (
        <>
          <IconSearch size={17} />
          <input
            autoFocus
            value={query}
            placeholder={t('thread.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('thread.search')}
          />
          <button
            className="icon-btn"
            aria-label={t('common.close')}
            onClick={() => {
              setQuery('')
              setSearching(false)
            }}
          >
            <IconX size={18} />
          </button>
        </>
      ) : (
        <button className="search-open" onClick={() => setSearching(true)}>
          <IconSearch size={16} />
          {t('thread.searchShort')}
        </button>
      )}
    </div>
  )

  if (q) {
    const total = results.reduce((s, tx) => s + signedMain(tx), 0)
    return (
      <div className="thread">
        {searchBar}
        <p className="search-count">
          {t('thread.found', { n: results.length })}
          {results.length > 0 && <span> · {formatMoney(total, mainCurrency, { sign: true })}</span>}
        </p>
        <div className="list">
          {results.map((tx) => {
            const d = describe(tx)
            return (
              <button key={tx.id} className="list-row search-row" onClick={() => props.onOpen(tx)}>
                <span className="row-icon" style={{ '--c': d.goal?.color ?? d.cat?.color ?? 'var(--muted)' } as CSSProperties}>
                  <CategoryIcon name={iconOf(tx, d.cat?.icon)} size={16} />
                </span>
                <span className="grow">
                  {d.title}
                  <span className="tx-meta" style={{ display: 'block' }}>
                    {shortDay().format(tx.date)} · {d.metaText}
                  </span>
                </span>
                <span className={`amount ${d.tone}`}>{d.amount}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  let offset = 0
  let leafCount = 0
  return (
    <div className="thread">
      {monthTx.length > 0 && searchBar}
      {rows.map((row) => {
        const h = ROW[row.type]
        const y = offset
        offset += h

        if (row.type === 'forecast') {
          // In cima: il filo "futuro", tratteggiato, che scende verso oggi.
          const startY = h * 0.38
          return (
            <div key="forecast" className="row row-forecast" style={{ height: h }}>
              <svg width={LANE} height={h} aria-hidden="true">
                <path
                  d={pathBetween(startY, h, y)}
                  stroke={tone(row.to)}
                  strokeWidth={Math.min(4, width(row.from), width(row.to))}
                  strokeDasharray="0.5 8"
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.55}
                />
              </svg>
              <div className="row-body forecast-body">
                <span className="muted forecast-label">
                  {t('thread.forecast')}
                  {forecastInfo && (
                    <button
                      className="info-btn"
                      aria-label={t('thread.forecastWhat')}
                      aria-expanded={infoOpen}
                      onClick={(e) => (e.stopPropagation(), setInfoOpen((v) => !v))}
                    >
                      <IconInfoCircle size={16} />
                    </button>
                  )}
                </span>
                <span className={row.to < 0 ? 'amount negative' : 'muted'}>{formatMoney(row.to, mainCurrency)}</span>
                {infoOpen && forecastInfo && (
                  <div className="info-pop" role="note" onClick={() => setInfoOpen(false)}>
                    <strong>{t('thread.forecastWhat')}</strong>
                    <p>
                      {t('thread.forecastHow', {
                        perDay: formatMoney(forecastInfo.perDay, mainCurrency),
                        days: forecastInfo.daysLeft,
                        amount: formatMoney(forecastInfo.projected, mainCurrency),
                      })}
                    </p>
                    <p className="muted">
                      {forecastInfo.excluded > 0
                        ? t('thread.forecastExcluded', { amount: formatMoney(forecastInfo.excluded, mainCurrency) })
                        : t('thread.forecastExcludedNone')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )
        }

        if (row.type === 'start') {
          return (
            <div key="start" className="row row-start" style={{ height: h }}>
              <svg width={LANE} height={h} aria-hidden="true">
                <path d={pathBetween(0, h / 2, y)} stroke={tone(row.balance)} strokeWidth={width(row.balance)} fill="none" strokeLinecap="round" />
                <circle cx={xAt(y + h / 2)} cy={h / 2} r={width(row.balance) / 2 + 2} fill="var(--branch)" />
              </svg>
              <div className="row-body">
                <span className="muted">{t('thread.start')}</span>
                <span className="muted">{formatMoney(row.balance, mainCurrency)}</span>
              </div>
            </div>
          )
        }

        if (row.type === 'day') {
          return (
            <div
              key={`day-${row.key}`}
              className={`row row-day collapsible${row.upcoming ? ' upcoming-day' : ''}`}
              style={{ height: h }}
              role="button"
              tabIndex={0}
              aria-expanded="true"
              onClick={() => toggle(row.key, true)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(row.key, true))}
            >
              <svg width={LANE} height={h} aria-hidden="true">
                <path d={pathBetween(0, h, y)} stroke={tone(row.balance)} strokeWidth={width(row.balance)} fill="none" strokeLinecap="round" />
              </svg>
              <div className="row-body">
                <span className="day-label">{dayLabel(row.date)}</span>
                {row.spent > 0 && <span className="day-total">{formatMoney(-row.spent, mainCurrency)}</span>}
              </div>
            </div>
          )
        }

        if (row.type === 'summary') {
          // Giorno compattato: un nodo con i colori delle sue categorie principali.
          const mid = h / 2
          const x = xAt(y + mid)
          const colors = [...new Set(row.txs.map((tx) => (tx.categoryId ? catById.get(tx.categoryId)?.color : tx.goalId ? goalById.get(tx.goalId)?.color : undefined)).filter(Boolean))].slice(0, 3) as string[]
          const net = row.after - row.before
          return (
            <button key={`sum-${row.key}`} className="row row-summary" style={{ height: h }} onClick={() => toggle(row.key, false)} aria-expanded="false">
              <svg width={LANE} height={h} aria-hidden="true">
                <path d={pathBetween(0, mid, y)} stroke={tone(row.after)} strokeWidth={width(row.after)} fill="none" strokeLinecap="round" />
                <path d={pathBetween(mid, h, y)} stroke={tone(row.before)} strokeWidth={width(row.before)} fill="none" strokeLinecap="round" />
                <g className="knot">
                  {colors.map((c, i) => (
                    <circle key={c} cx={x - 5 + i * 5} cy={mid} r={6} fill={c} stroke="var(--bg)" strokeWidth={2} />
                  ))}
                  {colors.length === 0 && <circle cx={x} cy={mid} r={6} fill="var(--muted)" stroke="var(--bg)" strokeWidth={2} />}
                </g>
              </svg>
              <div className="row-body">
                <span className="tx-text">
                  <span className="tx-title summary-title">{dayFormat().format(row.date)}</span>
                  <span className="tx-meta">{t('thread.dayCount', { n: row.txs.length })}</span>
                </span>
                <span className="amount summary-amount">
                  {row.spent > 0 ? formatMoney(-row.spent, mainCurrency) : formatMoney(net, mainCurrency, { sign: true })}
                  <IconChevronDown size={14} className="summary-chevron" />
                </span>
              </div>
            </button>
          )
        }

        const { tx } = row
        const d = describe(tx)
        const mid = h / 2
        const x = xAt(y + mid)
        const r = 5 + 7 * Math.sqrt(tx.mainAmount / maxAmount)
        // Le foglie si alternano ai lati del ramo, come su un ramo vero.
        const side: 1 | -1 = leafCount++ % 2 === 0 ? 1 : -1
        const leafColor = d.cat?.color ?? 'var(--muted)'

        return (
          <button
            key={tx.id}
            className={`row row-tx${tx.id === freshId ? ' fresh' : ''}${d.upcoming ? ' upcoming' : ''}`}
            style={{ height: h }}
            onClick={() => props.onOpen(tx)}
          >
            <svg width={LANE} height={h} aria-hidden="true">
              {/* Dall'alto (dopo il movimento) al basso (prima): il ramo sotto è quello di prima. */}
              <path d={pathBetween(0, mid, y)} stroke={tone(row.after)} strokeWidth={width(row.after)} fill="none" strokeLinecap="round" />
              <path d={pathBetween(mid, h, y)} stroke={tone(row.before)} strokeWidth={width(row.before)} fill="none" strokeLinecap="round" />
              {tx.kind === 'opening' ? (
                <g className="knot">
                  <circle cx={x} cy={mid} r={10} fill="var(--bg)" stroke="var(--branch)" strokeWidth={2.5} />
                  <circle cx={x} cy={mid} r={4} fill="var(--branch)" />
                </g>
              ) : tx.kind === 'transfer' ? (
                <circle className="knot" cx={x} cy={mid} r={5} fill="var(--bg)" stroke="var(--muted)" strokeWidth={1.5} />
              ) : tx.kind === 'save' || tx.kind === 'release' ? (
                <FigKnot x={x} y={mid} size={Math.max(18, r * 2.4)} color={d.goal?.color ?? 'var(--muted)'} />
              ) : tx.kind === 'income' ? (
                <Bud x={x} y={mid} r={Math.max(4.5, r * 0.75)} color={leafColor} />
              ) : (
                <Leaf x={x} y={mid} length={Math.min(10 + r * 1.4, side === 1 ? LANE - x - 2 : x - 2)} side={side} color={leafColor} ring={d.goal?.color} />
              )}
            </svg>
            <div className="row-body">
              <span className="row-icon tx-icon" aria-hidden="true" style={{ '--c': d.goal && tx.kind !== 'expense' ? d.goal.color : (d.cat?.color ?? 'var(--muted)') } as CSSProperties}>
                <CategoryIcon name={iconOf(tx, d.cat?.icon)} size={16} />
              </span>
              <span className="tx-text">
                <span className="tx-title">{d.title}</span>
                <span className="tx-meta">{d.metaText}</span>
              </span>
              <span className={`amount ${d.tone}`}>
                {d.amount}
                {d.converted && <span className="tx-meta">{d.converted}</span>}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
