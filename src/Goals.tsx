import { useId, useMemo, useState } from 'react'
import type { SheetPreset } from './AddSheet'
import { goalBalances, type AppData } from './data'
import { db, WOOL, type Goal, type Transaction } from './db'
import { dateFmt, numberToInput, t } from './i18n'
import { IconLeft } from './icons'
import { formatMoney, fromMinor, parseTyped } from './money'

const monthYear = () => dateFmt({ month: 'long', year: 'numeric' })
const shortDate = () => dateFmt({ day: 'numeric', month: 'short', year: 'numeric' })

/** Un gomitolo disegnato: si riempie dal basso man mano che ci metti soldi. */
export function YarnBall({ color, progress, size = 64 }: { color: string; progress: number; size?: number }) {
  const id = useId()
  const r = size / 2 - 4
  const c = size / 2
  const level = c + r - 2 * r * Math.min(1, Math.max(0, progress))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: 'none', overflow: 'visible' }}>
      <defs>
        <clipPath id={id}>
          <circle cx={c} cy={c} r={r} />
        </clipPath>
      </defs>
      <circle cx={c} cy={c} r={r} fill="var(--key)" />
      <g clipPath={`url(#${id})`}>
        <rect x={0} y={level} width={size} height={size} fill={color} />
        {/* Fili avvolti: archi che danno l'aspetto del gomitolo. */}
        {[-0.55, -0.2, 0.15, 0.5].map((k, i) => (
          <ellipse
            key={i}
            cx={c + k * r * 0.6}
            cy={c}
            rx={r * 0.35}
            ry={r * 1.05}
            transform={`rotate(${35 + i * 12} ${c} ${c})`}
            fill="none"
            stroke="var(--surface)"
            strokeOpacity={0.35}
            strokeWidth={1.2}
          />
        ))}
      </g>
      <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={2} />
      <path
        d={`M ${c + r * 0.7} ${c + r * 0.72} q ${r * 0.5} ${r * 0.1} ${r * 0.45} ${r * 0.5} t ${r * 0.4} ${r * 0.25}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Mesi rimanenti fino alla scadenza, contando quello in corso. */
function monthsUntil(deadline: number): number {
  const now = new Date()
  const d = new Date(deadline)
  return (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth() + 1
}

interface GoalsProps {
  data: AppData
  onAdd: (preset: SheetPreset) => void
  onEdit: (goal: Goal | null) => void
}

export function Goals({ data, onAdd, onEdit }: GoalsProps) {
  const { goals, transactions, mainCurrency } = data
  const balances = useMemo(() => goalBalances(transactions), [transactions])
  const [showArchived, setShowArchived] = useState(false)
  const active = goals.filter((g) => !g.archived)
  const archived = goals.filter((g) => g.archived)
  const total = active.reduce((sum, g) => sum + (balances.get(g.id) ?? 0), 0)

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const thisMonth = (goalId: string) =>
    transactions
      .filter((tx) => tx.goalId === goalId && tx.date >= monthStart && (tx.kind === 'save' || tx.kind === 'release'))
      .reduce((s, tx) => s + (tx.kind === 'save' ? tx.mainAmount : -tx.mainAmount), 0)

  function card(g: Goal) {
    const saved = balances.get(g.id) ?? 0
    const progress = g.target > 0 ? saved / g.target : 0
    const missing = Math.max(0, g.target - saved)
    const months = g.deadline ? monthsUntil(g.deadline) : null
    const month = thisMonth(g.id)
    let plan = ''
    if (g.target > 0 && missing === 0) plan = t('goals.reached')
    else if (g.target > 0 && months !== null && months > 0)
      plan = t('goals.perMonth', { amount: formatMoney(Math.ceil(missing / months), mainCurrency), date: monthYear().format(g.deadline!) })
    else if (months !== null && months <= 0) plan = t('goals.overdue', { date: monthYear().format(g.deadline!) })
    else if (g.target > 0) plan = t('goals.missing', { amount: formatMoney(missing, mainCurrency) })

    return (
      <section key={g.id} className={`card goal-card${g.archived ? ' archived' : ''}`}>
        <button className="goal-head" onClick={() => onEdit(g)}>
          <YarnBall color={g.color} progress={g.target > 0 ? progress : saved > 0 ? 0.5 : 0} />
          <span className="goal-text">
            <span className="goal-name">{g.name}</span>
            <span className="goal-amount">
              {formatMoney(saved, mainCurrency)}
              {g.target > 0 && <span className="muted"> {t('goals.of', { amount: formatMoney(g.target, mainCurrency) })}</span>}
            </span>
            {g.target > 0 && <span className="muted small">{Math.min(100, Math.round(progress * 100))}%</span>}
          </span>
        </button>
        {(plan || month !== 0) && (
          <p className="goal-plan">
            {plan}
            {plan && month !== 0 && ' · '}
            {month !== 0 && t('goals.thisMonth', { amount: formatMoney(month, mainCurrency, { sign: true }) })}
          </p>
        )}
        {!g.archived && (
          <div className="goal-actions">
            <button className="primary" onClick={() => onAdd({ mode: 'goal', goalDir: 'save', goalId: g.id })}>
              {t('goals.putAside')}
            </button>
            <button className="secondary" onClick={() => onAdd({ mode: 'expense', goalId: g.id })}>
              {t('goals.spend')}
            </button>
            {saved > 0 && (
              <button className="secondary" onClick={() => onAdd({ mode: 'goal', goalDir: 'release', goalId: g.id })}>
                {t('goals.takeBack')}
              </button>
            )}
          </div>
        )}
      </section>
    )
  }

  return (
    <main>
      <h1 className="screen-title">{t('goals.title')}</h1>
      <p className="muted small" style={{ margin: '0 0 16px' }}>
        {active.length > 0 ? t('goals.summary', { amount: formatMoney(total, mainCurrency) }) : t('goals.intro')}
      </p>

      {active.map(card)}

      <button className="card new-goal" onClick={() => onEdit(null)}>
        <span className="new-goal-plus">+</span>
        <span>
          <span className="goal-name">{t('goals.new')}</span>
          <span className="muted small" style={{ display: 'block' }}>
            {t('goals.newHint')}
          </span>
        </span>
      </button>

      {archived.length > 0 && (
        <>
          <button className="section-title as-button" onClick={() => setShowArchived((v) => !v)}>
            {t('goals.archived', { n: archived.length })} {showArchived ? '▾' : '▸'}
          </button>
          {showArchived && archived.map(card)}
        </>
      )}
    </main>
  )
}

interface FormProps {
  data: AppData
  goal: Goal | null
  onDone: () => void
  onOpenTx: (tx: Transaction) => void
}

export function GoalForm({ data, goal, onDone, onOpenTx }: FormProps) {
  const { mainCurrency, goals, transactions } = data
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(goal && goal.target > 0 ? numberToInput(fromMinor(goal.target, mainCurrency.decimals)) : '')
  const [deadline, setDeadline] = useState(() => {
    if (!goal?.deadline) return ''
    const d = new Date(goal.deadline)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [color, setColor] = useState(goal?.color ?? WOOL[(goals.length * 3 + 5) % WOOL.length])
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const history = transactions.filter((tx) => tx.goalId === goal?.id).reverse()
  const saved = history.reduce((s, tx) => s + (tx.kind === 'save' ? tx.mainAmount : -tx.mainAmount), 0)

  async function save() {
    if (!name.trim()) return setError(t('goalForm.nameErr'))
    let deadlineTs: number | undefined
    if (deadline) {
      const [y, m] = deadline.split('-').map(Number)
      deadlineTs = new Date(y, m, 0, 23, 59).getTime()
    }
    await db.goals.put({
      id: goal?.id ?? crypto.randomUUID(),
      name: name.trim(),
      target: Math.max(0, parseTyped(target, mainCurrency.decimals)),
      deadline: deadlineTs,
      color,
      order: goal?.order ?? Math.max(0, ...goals.map((g) => g.order)) + 1,
      archived: goal?.archived ?? false,
    })
    onDone()
  }

  async function toggleArchive() {
    if (!goal) return
    await db.goals.update(goal.id, { archived: !goal.archived })
    onDone()
  }

  async function remove() {
    if (!goal) return
    if (!confirmDelete) return setConfirmDelete(true)
    await db.goals.delete(goal.id)
    onDone()
  }

  const kindLabel = (tx: Transaction) =>
    tx.kind === 'save' ? t('goalForm.kindSave') : tx.kind === 'release' ? t('goalForm.kindRelease') : t('goalForm.kindSpent')

  return (
    <>
      <header className="bar">
        <button className="icon-btn" aria-label={t('common.back')} onClick={onDone}>
          <IconLeft />
        </button>
        <span style={{ fontWeight: 500 }}>{goal ? t('goalForm.edit') : t('goals.new')}</span>
        <span style={{ width: 36 }} />
      </header>

      <div className="goal-preview">
        <YarnBall color={color} progress={goal && goal.target > 0 ? saved / goal.target : 0.35} size={96} />
      </div>

      <div className="card form">
        <label className="field">
          {t('goalForm.what')}
          <input value={name} autoFocus={!goal} onChange={(e) => (setName(e.target.value), setError(''))} placeholder={t('goalForm.placeholder')} />
        </label>
        {!goal && !name && (
          <div className="chips">
            {t('goalForm.suggestions')
              .split('|')
              .map((s) => (
                <button key={s} className="chip ghost" onClick={() => setName(s)}>
                  {s}
                </button>
              ))}
          </div>
        )}
        <div className="form-row">
          <label className="field">
            {t('goalForm.target', { symbol: mainCurrency.symbol })}
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('goalForm.optional')} />
          </label>
          <label className="field">
            {t('goalForm.by')}
            <input type="month" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
        </div>
        <div className="field">
          {t('common.color')}
          <div className="swatches">
            {WOOL.map((c) => (
              <button key={c} className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {goal && (
            <button className="secondary" onClick={toggleArchive}>
              {goal.archived ? t('common.restore') : t('common.archive')}
            </button>
          )}
          <button className="primary" onClick={save}>
            {goal ? t('common.save') : t('goalForm.create')}
          </button>
        </div>
      </div>

      {goal && (
        <>
          <p className="section-title">{t('goalForm.history')}</p>
          {history.length === 0 ? (
            <p className="note-box">
              {t('goalForm.empty')}{' '}
              <button className={`danger-link${confirmDelete ? ' armed' : ''}`} style={{ padding: 0 }} onClick={remove}>
                {confirmDelete ? t('goalForm.deleteConfirm') : t('goalForm.deleteIt')}
              </button>
              .
            </p>
          ) : (
            <div className="list">
              {history.map((tx) => (
                <button key={tx.id} className="list-row" onClick={() => onOpenTx(tx)}>
                  <span className="grow">
                    {kindLabel(tx)}
                    {tx.note && <span className="muted small"> · {tx.note}</span>}
                    <span className="muted small" style={{ display: 'block' }}>
                      {shortDate().format(tx.date)}
                    </span>
                  </span>
                  <span className="legend-value">{formatMoney(tx.kind === 'save' ? tx.mainAmount : -tx.mainAmount, mainCurrency, { sign: true })}</span>
                </button>
              ))}
            </div>
          )}
          {history.length > 0 && !goal.archived && saved === 0 && <p className="note-box">{t('goalForm.emptyNow')}</p>}
        </>
      )}
    </>
  )
}
