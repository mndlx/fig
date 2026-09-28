import { IconRepeat } from '@tabler/icons-react'
import { useMemo, useState, type CSSProperties } from 'react'
import type { MonthView } from './App'
import { CategoryIcon } from './catIcons'
import type { AppData } from './data'
import type { Category, Transaction } from './db'
import { builtinName, dateFmt, t } from './i18n'
import { formatMoney } from './money'

interface Props {
  data: AppData
  view: MonthView
  monthOffset: number
  onOpen: (tx: Transaction) => void
  onPickMonth: (offset: number) => void
}

const DAY = 86_400_000
const weekdays = () => t('weave.weekdays').split(' ')
const shortMonth = () => dateFmt({ month: 'short' })
const longMonth = () => dateFmt({ month: 'long' })
const dayFormat = () => dateFmt({ weekday: 'long', day: 'numeric', month: 'long' })
const shortDay = () => dateFmt({ day: 'numeric', month: 'short' })

/** Uscite per categoria, in valuta principale. */
function byCategory(transactions: Transaction[], keep: (tx: Transaction) => boolean): Map<string, number> {
  const out = new Map<string, number>()
  for (const tx of transactions) {
    if (tx.kind !== 'expense' || !keep(tx)) continue
    const key = tx.categoryId ?? ''
    out.set(key, (out.get(key) ?? 0) + tx.mainAmount)
  }
  return out
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

function sortedStrands(sums: Map<string, number>, catById: Map<string, Category>) {
  return [...sums.entries()]
    .map(([id, value]) => ({ id, value, cat: catById.get(id) }))
    .sort((a, b) => (a.cat?.order ?? 99) - (b.cat?.order ?? 99))
}

/** Scala delle celle: il 85° percentile delle giornate, così un affitto non schiaccia tutto il resto. */
function scaleCap(values: number[]): number {
  const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (nonZero.length === 0) return 1
  return Math.max(1, nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.85))])
}

export function Trama({ data, view, monthOffset, onOpen, onPickMonth }: Props) {
  const [mode, setMode] = useState<'month' | 'year'>('month')
  const [focus, setFocus] = useState<string | null>(null)
  const [pickedDay, setPickedDay] = useState<number | null>(null)
  const [withFixed, setWithFixed] = useState(false)
  const { mainCurrency, transactions, categories, goals } = data
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const color = (id: string) => catById.get(id)?.color ?? 'var(--muted)'
  const name = (id: string) => {
    const c = catById.get(id)
    return c ? builtinName(c, 'cat') : t('thread.uncategorized')
  }
  const money = (v: number, sign = false) => formatMoney(v, mainCurrency, { sign })
  const now = Date.now()

  /** Etichetta di un movimento qualsiasi, come nel filo. */
  function label(tx: Transaction): string {
    if (tx.kind === 'opening') return t('thread.opening')
    if (tx.kind === 'transfer') return t('thread.transfer')
    if (tx.kind === 'save' || tx.kind === 'release') return goals.find((g) => g.id === tx.goalId)?.name ?? t('thread.stash')
    if (tx.note && !tx.categoryId) return tx.note
    return name(tx.categoryId ?? '')
  }

  const month = useMemo(() => {
    const y = view.start.getFullYear()
    const m = view.start.getMonth()
    const days = new Date(y, m + 1, 0).getDate()
    const lead = (view.start.getDay() + 6) % 7
    const txs = view.monthTx

    // Riepilogo: le scadenze future (ricorrenti in arrivo) sono tenute a parte.
    let spent = 0
    let scheduled = 0
    let income = 0
    let saved = 0
    for (const tx of txs) {
      if (tx.kind === 'expense') {
        if (tx.date > now) scheduled += tx.mainAmount
        else spent += tx.mainAmount
      }
      if (tx.kind === 'income') income += tx.mainAmount
      if (tx.kind === 'save') saved += tx.mainAmount
      if (tx.kind === 'release') saved -= tx.mainAmount
    }
    const left = income - spent - scheduled - saved

    // Spesa "di tutti i giorni": senza le ricorrenti, per la media e il calendario.
    const isVariable = (tx: Transaction) => !tx.recurringId
    const elapsedDays = view.isCurrent ? Math.max(1, Math.ceil((now - view.start.getTime()) / DAY)) : days
    const variable = sum(byCategory(txs, (tx) => isVariable(tx) && tx.date <= now))
    const prevStart = new Date(y, m - 1, 1).getTime()
    const prevTx = transactions.filter((tx) => tx.date >= prevStart && tx.date < view.start.getTime())
    const prevDays = new Date(y, m, 0).getDate()
    const prevVariable = sum(byCategory(prevTx, isVariable))

    const perDay = Array.from({ length: days }, (_, i) => {
      const from = new Date(y, m, i + 1).getTime()
      const to = new Date(y, m, i + 2).getTime()
      return byCategory(txs, (tx) => tx.date >= from && tx.date < to && (withFixed || isVariable(tx)))
    })
    const dayTotals = perDay.map(sum)
    const cap = scaleCap(dayTotals)

    const totals = byCategory(txs, () => true)
    const prev = byCategory(prevTx, () => true)
    const legend = [...totals.entries()].sort((a, b) => b[1] - a[1])
    const fixed = txs.filter((tx) => tx.recurringId && (tx.kind === 'expense' || tx.kind === 'income')).sort((a, b) => a.date - b.date)

    return {
      y,
      m,
      days,
      lead,
      spent,
      scheduled,
      income,
      saved,
      left,
      daily: variable / elapsedDays,
      prevDaily: prevVariable > 0 ? prevVariable / prevDays : null,
      perDay,
      dayTotals,
      cap,
      legend,
      total: sum(totals),
      prev,
      fixed,
    }
  }, [view, transactions, withFixed, now])

  const year = useMemo(() => {
    const y = view.start.getFullYear()
    const inYear = transactions.filter((tx) => new Date(tx.date).getFullYear() === y)
    const months = Array.from({ length: 12 }, (_, m) => byCategory(inYear, (tx) => new Date(tx.date).getMonth() === m))
    const monthTotals = months.map(sum)
    const all = byCategory(inYear, () => true)
    let income = 0
    let saved = 0
    for (const tx of inYear) {
      if (tx.kind === 'income') income += tx.mainAmount
      if (tx.kind === 'save') saved += tx.mainAmount
      if (tx.kind === 'release') saved -= tx.mainAmount
    }
    const spent = sum(all)
    return { y, months, monthTotals, max: Math.max(1, ...monthTotals), legend: [...all.entries()].sort((a, b) => b[1] - a[1]), spent, income, saved }
  }, [view.start, transactions])

  const today = new Date()
  const prevName = longMonth().format(new Date(month.y, month.m - 1, 1))
  const dayTx = pickedDay !== null ? view.monthTx.filter((tx) => new Date(tx.date).getDate() === pickedDay) : []
  const legend = mode === 'month' ? month.legend : year.legend
  const legendTotal = mode === 'month' ? month.total : year.spent

  const stat = (labelText: string, value: string, extra?: string, tone?: 'positive' | 'negative') => (
    <div className="stat">
      <span className="stat-label">{labelText}</span>
      <span className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</span>
      {extra && <span className="stat-extra">{extra}</span>}
    </div>
  )

  return (
    <main>
      <h1 className="screen-title">{mode === 'month' ? t('weave.titleMonth', { month: longMonth().format(view.start) }) : t('weave.titleYear', { year: year.y })}</h1>

      <div className="switch" role="tablist">
        <button role="tab" aria-selected={mode === 'month'} className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>
          {t('weave.month')}
        </button>
        <button role="tab" aria-selected={mode === 'year'} className={mode === 'year' ? 'on' : ''} onClick={() => setMode('year')}>
          {t('weave.year')}
        </button>
      </div>

      {mode === 'month' ? (
        <>
          <section className="card stats">
            {stat(t('weave.stat.spent'), money(month.spent), month.scheduled > 0 ? t('weave.scheduled', { amount: money(month.scheduled) }) : undefined)}
            {stat(t('weave.stat.income'), money(month.income))}
            {stat(t('weave.stat.saved'), money(month.saved))}
            {stat(t('weave.stat.left'), money(month.left, true), undefined, month.left < 0 ? 'negative' : 'positive')}
            <p className="stats-foot">
              {t('weave.daily', { amount: money(Math.round(month.daily)) })}
              {month.prevDaily !== null && (
                <span className="muted"> · {t('weave.dailyPrev', { month: prevName, amount: money(Math.round(month.prevDaily)) })}</span>
              )}
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">{t('weave.dayByDay')}</h2>
              <button className={`chip-toggle${withFixed ? ' on' : ''}`} onClick={() => setWithFixed((v) => !v)} aria-pressed={withFixed}>
                <IconRepeat size={13} />
                {t('weave.fixedToggle')}
              </button>
            </div>
            <div className="weekdays">
              {weekdays().map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="loom">
              {Array.from({ length: month.lead }, (_, i) => (
                <span key={`b${i}`} className="cell blank" />
              ))}
              {month.perDay.map((sums, i) => {
                const day = i + 1
                const date = new Date(month.y, month.m, day)
                const isToday = date.toDateString() === today.toDateString()
                const future = date.getTime() > now && !isToday
                const total = month.dayTotals[i]
                const height = total > 0 ? 22 + 78 * Math.min(1, Math.sqrt(total / month.cap)) : 0
                return (
                  <button
                    key={day}
                    className={`cell${height > 72 ? ' filled' : ''}${future ? ' future' : ''}${isToday ? ' today' : ''}${pickedDay === day ? ' picked' : ''}${total > month.cap ? ' peak' : ''}`}
                    onClick={() => setPickedDay(pickedDay === day ? null : day)}
                    aria-label={`${dayFormat().format(date)}: ${money(total)}`}
                    style={{ alignItems: 'flex-end' }}
                  >
                    <span className="cell-num">{day}</span>
                    <span style={{ display: 'flex', width: '100%', height: `${height}%` }}>
                      {sortedStrands(sums, catById).map((s) => (
                        <span key={s.id} className={`strand${focus !== null && focus !== s.id ? ' dim' : ''}`} style={{ flexGrow: s.value, background: color(s.id) }} />
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              {withFixed ? t('weave.hintWithFixed') : t('weave.hintDaily')}
            </p>

            {pickedDay !== null && (
              <div className="day-list">
                <div className="day-list-head">
                  <span>{dayFormat().format(new Date(month.y, month.m, pickedDay))}</span>
                  <span className="muted">{money(dayTx.filter((tx) => tx.kind === 'expense').reduce((s, tx) => s + tx.mainAmount, 0))}</span>
                </div>
                {dayTx.length === 0 && <p className="muted small" style={{ margin: 4 }}>{t('weave.noTx')}</p>}
                {dayTx.map((tx) => {
                  const cat = tx.categoryId ? catById.get(tx.categoryId) : undefined
                  const out = tx.kind === 'expense' || tx.kind === 'save'
                  return (
                    <button key={tx.id} className="day-list-row" onClick={() => onOpen(tx)}>
                      <span className="row-icon" style={{ '--c': cat?.color ?? 'var(--muted)' } as CSSProperties}>
                        <CategoryIcon name={cat?.icon ?? (tx.kind === 'opening' ? 'wallet' : 'dots')} size={16} />
                      </span>
                      <span className="grow">
                        {label(tx)}
                        {tx.note && tx.categoryId && <span className="muted small"> · {tx.note}</span>}
                      </span>
                      <span className={`legend-value${!out && tx.kind !== 'transfer' ? ' positive' : ''}`}>
                        {tx.kind === 'transfer' ? money(tx.mainAmount) : money(out ? -tx.mainAmount : tx.mainAmount, !out)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="card stats three">
            {stat(t('weave.stat.spent'), money(year.spent))}
            {stat(t('weave.stat.income'), money(year.income))}
            {stat(t('weave.stat.saved'), money(year.saved))}
          </section>
          <section className="card">
            <div className="tapestry">
              {year.months.map((sums, m) => {
                const total = year.monthTotals[m]
                const offset = (year.y - today.getFullYear()) * 12 + m - today.getMonth()
                return (
                  <button
                    key={m}
                    className={`tapestry-row${offset === monthOffset ? ' current' : ''}`}
                    onClick={() => {
                      onPickMonth(offset)
                      setMode('month')
                      setPickedDay(null)
                    }}
                  >
                    <span className="label">{shortMonth().format(new Date(year.y, m, 1)).replace('.', '')}</span>
                    <span className="tapestry-bar">
                      <span style={{ display: 'flex', width: `${(total / year.max) * 100}%` }}>
                        {sortedStrands(sums, catById).map((s) => (
                          <span key={s.id} className={`strand${focus !== null && focus !== s.id ? ' dim' : ''}`} style={{ flexGrow: s.value, background: color(s.id) }} />
                        ))}
                      </span>
                    </span>
                    <span className="legend-value">{total > 0 ? money(total) : '—'}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </>
      )}

      {legend.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('weave.categories')}</h2>
            {focus !== null && (
              <button className="chip-toggle on" onClick={() => setFocus(null)}>
                {name(focus)} ✕
              </button>
            )}
          </div>
          <div className="legend">
            {legend.map(([id, value]) => {
              const cat = catById.get(id)
              const before = month.prev.get(id) ?? 0
              const delta = before > 0 ? Math.round(((value - before) / before) * 100) : null
              const share = legendTotal > 0 ? Math.round((value / legendTotal) * 100) : 0
              return (
                <button key={id} className={`legend-row${focus === id ? ' on' : ''}`} onClick={() => setFocus(focus === id ? null : id)}>
                  <span className="row-icon" style={{ '--c': color(id) } as CSSProperties}>
                    <CategoryIcon name={cat?.icon} size={16} />
                  </span>
                  <span className="legend-name">
                    {name(id)}
                    <span className="legend-share">{share}%</span>
                    {mode === 'month' && delta !== null && Math.abs(delta) >= 10 && (
                      <span className={`delta ${delta > 0 ? 'up' : 'down'}`} title={t('weave.vs', { delta: `${delta > 0 ? '+' : ''}${delta}`, month: prevName })}>
                        {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}%
                      </span>
                    )}
                    {mode === 'month' && delta === null && <span className="delta new">{t('weave.new')}</span>}
                  </span>
                  <span className="legend-value">{money(value)}</span>
                  <span className="legend-bar">
                    <span style={{ width: `${(value / legend[0][1]) * 100}%`, background: color(id) }} />
                  </span>
                </button>
              )
            })}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            {t('weave.hint')}
          </p>
        </section>
      ) : (
        <section className="card empty-weave">
          <p className="empty-title">{t('weave.none')}</p>
          <p className="muted small">{t('weave.noneBody')}</p>
        </section>
      )}

      {mode === 'month' && month.fixed.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('weave.fixed')}</h2>
            <span className="muted small">{money(month.fixed.filter((tx) => tx.kind === 'expense').reduce((s, tx) => s + tx.mainAmount, 0))}</span>
          </div>
          {month.fixed.map((tx) => {
            const cat = tx.categoryId ? catById.get(tx.categoryId) : undefined
            const due = tx.date > now
            return (
              <button key={tx.id} className={`day-list-row${due ? ' due' : ''}`} onClick={() => onOpen(tx)}>
                <span className="row-icon" style={{ '--c': cat?.color ?? 'var(--muted)' } as CSSProperties}>
                  <CategoryIcon name={cat?.icon} size={16} />
                </span>
                <span className="grow">
                  {tx.note || label(tx)}
                  <span className="muted small" style={{ display: 'block' }}>
                    {due ? t('weave.fixedDue', { date: shortDay().format(tx.date) }) : t('weave.fixedPaid', { date: shortDay().format(tx.date) })}
                  </span>
                </span>
                <span className={`legend-value${tx.kind === 'income' ? ' positive' : ''}`}>
                  {money(tx.kind === 'income' ? tx.mainAmount : -tx.mainAmount, tx.kind === 'income')}
                </span>
              </button>
            )
          })}
        </section>
      )}
    </main>
  )
}
