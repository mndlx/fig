import { useMemo, useState } from 'react'
import type { MonthView } from './App'
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

const weekdays = () => t('weave.weekdays').split(' ')
const shortMonth = () => dateFmt({ month: 'short' })
const longMonth = () => dateFmt({ month: 'long' })
const dayFormat = () => dateFmt({ weekday: 'long', day: 'numeric', month: 'long' })

/** Uscite per categoria in un intervallo, in valuta principale. */
function expenseByCategory(transactions: Transaction[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const tx of transactions) {
    if (tx.kind !== 'expense' || tx.date < from || tx.date >= to) continue
    const key = tx.categoryId ?? ''
    out.set(key, (out.get(key) ?? 0) + tx.mainAmount)
  }
  return out
}

function sortedStrands(sums: Map<string, number>, catById: Map<string, Category>) {
  return [...sums.entries()]
    .map(([id, value]) => ({ id, value, cat: catById.get(id) }))
    .sort((a, b) => (a.cat?.order ?? 99) - (b.cat?.order ?? 99))
}

export function Trama({ data, view, monthOffset, onOpen, onPickMonth }: Props) {
  const [mode, setMode] = useState<'month' | 'year'>('month')
  const [focus, setFocus] = useState<string | null>(null)
  const [pickedDay, setPickedDay] = useState<number | null>(null)
  const { mainCurrency, transactions, categories } = data
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const color = (id: string) => catById.get(id)?.color ?? 'var(--muted)'
  const name = (id: string) => {
    const c = catById.get(id)
    return c ? builtinName(c, 'cat') : t('thread.uncategorized')
  }

  const month = useMemo(() => {
    const y = view.start.getFullYear()
    const m = view.start.getMonth()
    const days = new Date(y, m + 1, 0).getDate()
    const lead = (view.start.getDay() + 6) % 7
    const perDay = Array.from({ length: days }, (_, i) =>
      expenseByCategory(view.monthTx, new Date(y, m, i + 1).getTime(), new Date(y, m, i + 2).getTime()),
    )
    const dayTotals = perDay.map((s) => [...s.values()].reduce((a, b) => a + b, 0))
    const maxDay = Math.max(1, ...dayTotals)
    const totals = expenseByCategory(view.monthTx, view.start.getTime(), view.end.getTime())
    const prev = expenseByCategory(transactions, new Date(y, m - 1, 1).getTime(), view.start.getTime())
    const legend = [...totals.entries()].sort((a, b) => b[1] - a[1])
    return { y, m, days, lead, perDay, dayTotals, maxDay, legend, prev }
  }, [view, transactions])

  const year = useMemo(() => {
    const y = view.start.getFullYear()
    const months = Array.from({ length: 12 }, (_, m) =>
      expenseByCategory(transactions, new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()),
    )
    const monthTotals = months.map((s) => [...s.values()].reduce((a, b) => a + b, 0))
    const all = expenseByCategory(transactions, new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime())
    return { y, months, monthTotals, max: Math.max(1, ...monthTotals), legend: [...all.entries()].sort((a, b) => b[1] - a[1]) }
  }, [view.start, transactions])

  const today = new Date()
  const legend = mode === 'month' ? month.legend : year.legend
  const legendTotal = legend.reduce((sum, [, v]) => sum + v, 0)
  const prevName = longMonth().format(new Date(month.y, month.m - 1, 1))

  const dayTx =
    pickedDay !== null
      ? view.monthTx.filter((tx) => new Date(tx.date).getDate() === pickedDay)
      : []

  return (
    <main>
      <h1 className="screen-title">{mode === 'month' ? t('weave.titleMonth', { month: longMonth().format(view.start) }) : t('weave.titleYear', { year: year.y })}</h1>
      <p className="muted small" style={{ margin: 0 }}>
        {legendTotal > 0 ? t('weave.spent', { amount: formatMoney(legendTotal, mainCurrency) }) : t('weave.none')}
        {focus !== null && ` · ${t('weave.highlight', { name: name(focus) })}`}
      </p>

      <div className="switch" role="tablist">
        <button role="tab" aria-selected={mode === 'month'} className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>
          {t('weave.month')}
        </button>
        <button role="tab" aria-selected={mode === 'year'} className={mode === 'year' ? 'on' : ''} onClick={() => setMode('year')}>
          {t('weave.year')}
        </button>
      </div>

      {mode === 'month' ? (
        <section className="card">
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
              const future = date > today && !isToday
              const total = month.dayTotals[i]
              const strands = sortedStrands(sums, catById)
              // L'altezza del tessuto nel giorno cresce con quanto hai speso.
              const height = total > 0 ? 30 + 70 * Math.sqrt(total / month.maxDay) : 0
              return (
                <button
                  key={day}
                  className={`cell${height > 72 ? ' filled' : ''}${future ? ' future' : ''}${isToday ? ' today' : ''}${pickedDay === day ? ' picked' : ''}`}
                  onClick={() => setPickedDay(pickedDay === day ? null : day)}
                  aria-label={`${dayFormat().format(date)}: ${formatMoney(total, mainCurrency)}`}
                  style={{ alignItems: 'flex-end' }}
                >
                  <span className="cell-num">{day}</span>
                  <span style={{ display: 'flex', width: '100%', height: `${height}%` }}>
                    {strands.map((s) => (
                      <span
                        key={s.id}
                        className={`strand${focus !== null && focus !== s.id ? ' dim' : ''}`}
                        style={{ flexGrow: s.value, background: color(s.id) }}
                      />
                    ))}
                  </span>
                </button>
              )
            })}
          </div>

          {pickedDay !== null && (
            <div className="day-list">
              <p className="muted small" style={{ margin: '0 4px 4px' }}>
                {dayFormat().format(new Date(month.y, month.m, pickedDay))}
              </p>
              {dayTx.length === 0 && <p className="muted small" style={{ margin: '4px' }}>{t('weave.noTx')}</p>}
              {dayTx.map((tx) => (
                <button key={tx.id} className="day-list-row" onClick={() => onOpen(tx)}>
                  <span className="legend-dot" style={{ background: tx.categoryId ? color(tx.categoryId) : 'var(--muted)' }} />
                  <span>
                    {tx.kind === 'transfer'
                      ? t('thread.transfer')
                      : tx.kind === 'save' || tx.kind === 'release'
                        ? (data.goals.find((g) => g.id === tx.goalId)?.name ?? t('thread.stash'))
                        : name(tx.categoryId ?? '')}
                  </span>
                  {tx.note && <span className="muted small">{tx.note}</span>}
                  <span className={`legend-value${tx.kind === 'income' ? ' positive' : ''}`}>
                    {formatMoney(tx.kind === 'expense' || tx.kind === 'save' ? -tx.mainAmount : tx.mainAmount, mainCurrency, {
                      sign: tx.kind === 'income' || tx.kind === 'release',
                    })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
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
                        <span
                          key={s.id}
                          className={`strand${focus !== null && focus !== s.id ? ' dim' : ''}`}
                          style={{ flexGrow: s.value, background: color(s.id) }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="legend-value">{total > 0 ? formatMoney(total, mainCurrency) : '—'}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {legend.length > 0 && (
        <section className="card">
          <div className="legend">
            {legend.map(([id, value]) => {
              const before = month.prev.get(id) ?? 0
              const delta = before > 0 ? Math.round(((value - before) / before) * 100) : null
              return (
                <button key={id} className={`legend-row${focus === id ? ' on' : ''}`} onClick={() => setFocus(focus === id ? null : id)}>
                  <span className="legend-dot" style={{ background: color(id) }} />
                  <span className="legend-name">
                    {name(id)}{' '}
                    {mode === 'month' && (
                      <span className="legend-delta">
                        {delta === null ? t('weave.newThisMonth') : t('weave.vs', { delta: `${delta > 0 ? '+' : ''}${delta}`, month: prevName })}
                      </span>
                    )}
                  </span>
                  <span className="legend-value">{formatMoney(value, mainCurrency)}</span>
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
      )}
    </main>
  )
}
