import { useEffect, useMemo } from 'react'
import { signedMain } from './data'
import type { Account, Category, Currency, Goal, Transaction } from './db'
import { builtinName, dateFmt, t } from './i18n'
import { formatMoney } from './money'

const LANE = 64
const ROW = { start: 56, day: 38, tx: 64, forecast: 76 }

type Row =
  | { type: 'start'; balance: number }
  | { type: 'day'; date: Date; balance: number; spent: number }
  | { type: 'tx'; tx: Transaction; before: number; after: number }
  | { type: 'forecast'; from: number; to: number }

interface Props {
  startBalance: number
  monthTx: Transaction[]
  forecast: number | null
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
const timeFormat = () => dateFmt({ hour: '2-digit', minute: '2-digit' })

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function dayLabel(d: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (sameDay(d, today)) return t('common.today')
  if (sameDay(d, yesterday)) return t('common.yesterday')
  return dayFormat().format(d)
}

/** Nodo a forma di gomitolo, per i soldi messi da parte o ripresi. */
function YarnKnot({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return (
    <g className="knot">
      <circle cx={x} cy={y} r={r + 5} fill={color} opacity={0.18} />
      <circle cx={x} cy={y} r={r} fill={color} stroke="var(--bg)" strokeWidth={2.5} />
      <path
        d={`M ${x - r * 0.6} ${y - r * 0.3} q ${r * 0.6} ${r * 0.5} ${r * 1.1} ${r * 0.1} M ${x - r * 0.5} ${y + r * 0.35} q ${r * 0.6} -${r * 0.5} ${r * 1.05} ${r * 0.05}`}
        fill="none"
        stroke="var(--bg)"
        strokeOpacity={0.7}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </g>
  )
}

export function ThreadView(props: Props) {
  const { startBalance, monthTx, forecast, mainCurrency, currencies, categories, accounts, goals, freshId } = props

  const rows = useMemo(() => {
    const out: Row[] = [{ type: 'start', balance: startBalance }]
    let running = startBalance
    let dayRow: Extract<Row, { type: 'day' }> | null = null
    for (const tx of monthTx) {
      const d = new Date(tx.date)
      if (!dayRow || !sameDay(dayRow.date, d)) {
        dayRow = { type: 'day', date: d, balance: running, spent: 0 }
        out.push(dayRow)
      }
      if (tx.kind === 'expense') dayRow.spent += tx.mainAmount
      const delta = signedMain(tx)
      out.push({ type: 'tx', tx, before: running, after: running + delta })
      running += delta
    }
    if (forecast !== null) out.push({ type: 'forecast', from: running, to: forecast })
    return out
  }, [startBalance, monthTx, forecast])

  // Riferimento per lo spessore: il saldo più alto toccato nel mese.
  const ref = useMemo(() => {
    let max = Math.max(startBalance, 1)
    for (const r of rows) if (r.type === 'tx') max = Math.max(max, r.before, r.after)
    return max
  }, [rows, startBalance])

  const maxAmount = useMemo(() => Math.max(1, ...monthTx.map((t) => t.mainAmount)), [monthTx])

  const width = (balance: number) => (balance <= 0 ? 1.25 : 1.5 + 5.5 * Math.min(1, balance / ref))
  const tone = (balance: number) => (balance < 0 ? 'var(--danger)' : 'var(--thread)')

  // Dopo un salvataggio porta in vista il nodo appena annodato.
  useEffect(() => {
    if (freshId) document.querySelector('.row-tx.fresh')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [freshId, monthTx.length])

  const catById = new Map(categories.map((c) => [c.id, c]))
  const accById = new Map(accounts.map((a) => [a.id, a]))
  const accName = (id?: string) => {
    const a = id ? accById.get(id) : undefined
    return a ? builtinName(a, 'acc') : '?'
  }
  const curByCode = new Map(currencies.map((c) => [c.code, c]))
  const goalById = new Map(goals.map((g) => [g.id, g]))

  let offset = 0
  return (
    <div className="thread">
      {rows.map((row) => {
        const h = ROW[row.type]
        const y = offset
        offset += h

        if (row.type === 'start') {
          return (
            <div key="start" className="row row-start" style={{ height: h }}>
              <svg width={LANE} height={h} aria-hidden="true">
                <path d={pathBetween(h / 2, h, y)} stroke={tone(row.balance)} strokeWidth={width(row.balance)} fill="none" strokeLinecap="round" />
                <circle cx={xAt(y + h / 2)} cy={h / 2} r={width(row.balance) / 2 + 2} fill="var(--thread)" />
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
            <div key={`day-${row.date.toDateString()}`} className="row row-day" style={{ height: h }}>
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

        if (row.type === 'forecast') {
          const endY = h * 0.62
          return (
            <div key="forecast" className="row row-forecast" style={{ height: h }}>
              <svg width={LANE} height={h} aria-hidden="true">
                <path
                  d={pathBetween(0, endY, y)}
                  stroke={tone(row.to)}
                  strokeWidth={Math.min(4, width(row.from), width(row.to))}
                  strokeDasharray="0.5 8"
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.55}
                />
              </svg>
              <div className="row-body">
                <span className="muted">{t('thread.forecast')}</span>
                <span className={row.to < 0 ? 'amount negative' : 'muted'}>{formatMoney(row.to, mainCurrency)}</span>
              </div>
            </div>
          )
        }

        const { tx } = row
        const cat = tx.categoryId ? catById.get(tx.categoryId) : undefined
        const goal = tx.goalId ? goalById.get(tx.goalId) : undefined
        const cur = curByCode.get(tx.currency) ?? mainCurrency
        const mid = h / 2
        const x = xAt(y + mid)
        const r = 5 + 7 * Math.sqrt(tx.mainAmount / maxAmount)

        let title: string
        let meta: (string | null | undefined)[]
        let amountText: string
        let amountClass = 'amount'
        switch (tx.kind) {
          case 'opening':
            title = t('thread.opening')
            meta = [accName(tx.accountId), tx.note]
            amountText = formatMoney(tx.amount, cur)
            break
          case 'transfer':
            title = `${accName(tx.accountId)} → ${accName(tx.toAccountId)}`
            meta = [t('thread.transfer'), tx.note]
            amountText = formatMoney(tx.amount, cur)
            amountClass += ' muted'
            break
          case 'save':
            title = goal?.name ?? t('thread.stash')
            meta = [t('thread.saved'), tx.note]
            amountText = formatMoney(-tx.amount, cur)
            break
          case 'release':
            title = goal?.name ?? t('thread.stash')
            meta = [t('thread.released'), tx.note]
            amountText = formatMoney(tx.amount, cur, { sign: true })
            amountClass += ' positive'
            break
          default:
            title = cat ? builtinName(cat, 'cat') : t('thread.uncategorized')
            meta = [goal ? t('thread.fromGoal', { goal: goal.name }) : null, tx.note, accName(tx.accountId)]
            amountText = formatMoney(tx.kind === 'income' ? tx.amount : -tx.amount, cur, { sign: true })
            if (tx.kind === 'income') amountClass += ' positive'
            if (goal) amountClass += ' from-goal'
        }
        const upcoming = tx.date > Date.now()
        const metaText = [upcoming ? t('thread.upcoming') : null, tx.recurringId ? '↻' : null, ...meta, timeFormat().format(tx.date)]
          .filter(Boolean)
          .join(' · ')

        return (
          <button
            key={tx.id}
            className={`row row-tx${tx.id === freshId ? ' fresh' : ''}${upcoming ? ' upcoming' : ''}`}
            style={{ height: h }}
            onClick={() => props.onOpen(tx)}
          >
            <svg width={LANE} height={h} aria-hidden="true">
              <path d={pathBetween(0, mid, y)} stroke={tone(row.before)} strokeWidth={width(row.before)} fill="none" strokeLinecap="round" />
              <path d={pathBetween(mid, h, y)} stroke={tone(row.after)} strokeWidth={width(row.after)} fill="none" strokeLinecap="round" />
              {tx.kind === 'opening' ? (
                // Saldo iniziale: un rocchetto, l'inizio del filo di quel conto.
                <g className="knot">
                  <circle cx={x} cy={mid} r={10} fill="var(--bg)" stroke="var(--thread)" strokeWidth={2.5} />
                  <circle cx={x} cy={mid} r={4} fill="var(--thread)" />
                </g>
              ) : tx.kind === 'transfer' ? (
                <circle className="knot" cx={x} cy={mid} r={5} fill="var(--bg)" stroke="var(--muted)" strokeWidth={1.5} />
              ) : tx.kind === 'save' || tx.kind === 'release' ? (
                <YarnKnot x={x} y={mid} r={Math.max(7, r)} color={goal?.color ?? 'var(--muted)'} />
              ) : (
                <g className="knot">
                  <circle cx={x} cy={mid} r={r + 5} fill={cat?.color ?? 'var(--muted)'} opacity={0.18} />
                  {/* Spesa pagata da un gomitolo: anello del colore del gomitolo. */}
                  {goal && <circle cx={x} cy={mid} r={r + 3.5} fill="none" stroke={goal.color} strokeWidth={2} />}
                  <circle cx={x} cy={mid} r={r} fill={cat?.color ?? 'var(--muted)'} stroke="var(--bg)" strokeWidth={2.5} />
                </g>
              )}
            </svg>
            <div className="row-body">
              <span className="tx-text">
                <span className="tx-title">{title}</span>
                <span className="tx-meta">{metaText}</span>
              </span>
              <span className={amountClass}>
                {amountText}
                {tx.currency !== mainCurrency.code && tx.kind !== 'transfer' && (
                  <span className="tx-meta">{formatMoney(tx.kind === 'income' ? tx.mainAmount : -tx.mainAmount, mainCurrency)}</span>
                )}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
