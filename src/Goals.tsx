import { IconArrowBackUp, IconArrowDownRight, IconCar, IconGift, IconPencil, IconPlane, IconPlus, IconRepeat, IconShoppingBag, IconUmbrella } from '@tabler/icons-react'
import { useId, useMemo, useState, type CSSProperties } from 'react'
import type { SheetPreset } from './AddSheet'
import { goalBalances, goalDelta, type AppData } from './data'
import { db, WOOL, type Frequency, type Goal, type Transaction } from './db'
import { dateFmt, numberToInput, t, type Key } from './i18n'
import { IconLeft } from './icons'
import { formatMoney, fromMinor, parseTyped } from './money'
import { createAutoSave, updateSeries } from './recurring'

const DAY = 86_400_000
const monthYear = () => dateFmt({ month: 'long', year: 'numeric' })
const shortDate = () => dateFmt({ day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Un gomitolo disegnato: si riempie dal basso man mano che ci metti soldi.
 * Senza obiettivo il bordo è tratteggiato: il riempimento non misura niente.
 */
export function YarnBall({ color, progress, size = 64, open = false }: { color: string; progress: number; size?: number; open?: boolean }) {
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
      <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={2} strokeDasharray={open ? '3 3' : undefined} />
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

export type GoalStatus = 'reached' | 'onTrack' | 'behind' | 'pace' | 'needed' | 'overdue' | 'noTarget' | 'start'

export interface GoalStats {
  saved: number
  progress: number
  missing: number
  /** Quanto serve al mese per arrivare alla scadenza (se c'è). */
  needed: number | null
  /** Media netta messa da parte al mese negli ultimi 90 giorni. */
  pace: number
  /** Quando si arriva all'obiettivo al ritmo attuale. */
  projected: number | null
  thisMonth: number
  status: GoalStatus
}

/** Numeri di un gomitolo: quanto c'è, quanto manca, a che ritmo ci si arriva e se si è in linea. */
export function goalStats(goal: Goal, transactions: Transaction[], saved: number): GoalStats {
  const now = Date.now()
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  let recent = 0
  let thisMonth = 0
  for (const tx of transactions) {
    if (tx.goalId !== goal.id || (tx.kind !== 'save' && tx.kind !== 'release') || tx.date > now) continue
    const d = goalDelta(tx, goal.id)
    if (tx.date >= now - 90 * DAY) recent += d
    if (tx.date >= monthStart) thisMonth += d
  }
  const pace = Math.max(0, recent / 3)
  const missing = Math.max(0, goal.target - saved)
  const progress = goal.target > 0 ? saved / goal.target : 0
  const months = goal.deadline ? monthsUntil(goal.deadline) : null
  const needed = goal.target > 0 && months !== null && months > 0 ? Math.ceil(missing / months) : null
  let projected: number | null = null
  if (missing > 0 && pace > 0) {
    const d = new Date()
    d.setMonth(d.getMonth() + Math.ceil(missing / pace))
    projected = d.getTime()
  }

  let status: GoalStatus
  if (goal.target <= 0) status = 'noTarget'
  else if (missing === 0) status = 'reached'
  else if (months !== null && months <= 0) status = 'overdue'
  else if (goal.deadline && projected !== null) status = projected <= goal.deadline ? 'onTrack' : 'behind'
  else if (goal.deadline) status = 'needed'
  else if (projected !== null) status = 'pace'
  else status = 'start'
  return { saved, progress, missing, needed, pace, projected, thisMonth, status }
}

function statusText(goal: Goal, s: GoalStats, money: (v: number) => string): string {
  switch (s.status) {
    case 'reached':
      return t('goals.status.reached')
    case 'onTrack':
      return t('goals.status.onTrack', { date: monthYear().format(goal.deadline!) })
    case 'behind':
      return t('goals.status.behind', { amount: money(s.needed ?? 0) })
    case 'needed':
      return t('goals.status.needed', { amount: money(s.needed ?? 0), date: monthYear().format(goal.deadline!) })
    case 'overdue':
      return t('goals.overdue', { date: monthYear().format(goal.deadline!) })
    case 'pace':
      return t('goals.status.pace', { date: monthYear().format(s.projected!) })
    case 'noTarget':
      return t('goals.status.noTarget')
    default:
      return t('goals.missing', { amount: money(s.missing) })
  }
}

/** Importi dei gomitoli: interi quando possibile, i centesimi non aggiungono nulla a un obiettivo. */
function roundMoney(minor: number, decimals: number): number {
  const unit = 10 ** decimals
  return Math.round(minor / unit) * unit
}

export interface GoalTemplate {
  name: string
  color: string
}

interface GoalsProps {
  data: AppData
  onAdd: (preset: SheetPreset) => void
  onOpen: (goal: Goal) => void
  onEdit: (goal: Goal | null, template?: GoalTemplate) => void
}

const TEMPLATE_STYLE = [
  { color: '#2F6F73', icon: IconPlane },
  { color: '#D9A441', icon: IconUmbrella },
  { color: '#D28A8A', icon: IconGift },
  { color: '#4F6D8F', icon: IconCar },
]

/** Stato vuoto: cosa sono i gomitoli, come funzionano e modelli pronti da cui partire. */
function GoalsEmpty({ onEdit }: { onEdit: GoalsProps['onEdit'] }) {
  const names = t('goals.templates').split('|')
  const steps = [
    { icon: IconArrowDownRight, title: t('goals.how1'), body: t('goals.how1Body') },
    { icon: IconShoppingBag, title: t('goals.how2'), body: t('goals.how2Body') },
    { icon: IconArrowBackUp, title: t('goals.how3'), body: t('goals.how3Body') },
  ]
  return (
    <section className="goals-empty">
      <div className="goals-empty-art" aria-hidden="true">
        <YarnBall color="#7B4B6A" progress={0.62} size={120} />
        <span className="float a">
          <YarnBall color="#D9A441" progress={0.3} size={44} />
        </span>
        <span className="float b">
          <YarnBall color="#2F6F73" progress={0.8} size={34} />
        </span>
      </div>
      <h2 className="goals-empty-title">{t('goals.emptyTitle')}</h2>
      <p className="goals-empty-body">{t('goals.emptyBody')}</p>

      <ol className="how">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="how-icon">
              <s.icon size={18} />
            </span>
            <span>
              <strong>{s.title}</strong>
              <span className="muted small" style={{ display: 'block' }}>
                {s.body}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <p className="section-title">{t('goals.templatesTitle')}</p>
      <div className="templates">
        {names.map((name, i) => {
          const style = TEMPLATE_STYLE[i % TEMPLATE_STYLE.length]
          return (
            <button key={name} className="template" style={{ '--c': style.color } as CSSProperties} onClick={() => onEdit(null, { name, color: style.color })}>
              <span className="template-icon">
                <style.icon size={22} />
              </span>
              <span>{name}</span>
            </button>
          )
        })}
      </div>
      <button className="primary wide" onClick={() => onEdit(null)}>
        {t('goals.createCta')}
      </button>
    </section>
  )
}

export function Goals({ data, onAdd, onOpen, onEdit }: GoalsProps) {
  const { goals, transactions, mainCurrency } = data
  const balances = useMemo(() => goalBalances(transactions), [transactions])
  const [showArchived, setShowArchived] = useState(false)
  const active = goals.filter((g) => !g.archived)
  const archived = goals.filter((g) => g.archived)
  const money = (v: number, sign = false) => formatMoney(v, mainCurrency, { sign })
  const stats = new Map(goals.map((g) => [g.id, goalStats(g, transactions, balances.get(g.id) ?? 0)]))
  const total = active.reduce((sum, g) => sum + (balances.get(g.id) ?? 0), 0)
  const month = active.reduce((sum, g) => sum + (stats.get(g.id)?.thisMonth ?? 0), 0)

  function row(g: Goal) {
    const s = stats.get(g.id)!
    const tone = s.status === 'reached' || s.status === 'onTrack' ? 'good' : s.status === 'behind' || s.status === 'overdue' ? 'bad' : ''
    return (
      <div key={g.id} className={`goal-row${g.archived ? ' archived' : ''}`} style={{ '--c': g.color } as CSSProperties}>
        <button className="goal-row-main" onClick={() => onOpen(g)}>
          <YarnBall color={g.color} progress={g.target > 0 ? s.progress : s.saved > 0 ? 0.6 : 0} size={52} open={g.target <= 0} />
          <span className="goal-text">
            <span className="goal-name">{g.name}</span>
            <span className="goal-amount">
              {money(s.saved)}
              {g.target > 0 && <span className="muted"> / {money(g.target)}</span>}
            </span>
            {g.target > 0 && (
              <span className="goal-bar">
                <span style={{ width: `${Math.min(100, s.progress * 100)}%` }} />
              </span>
            )}
            <span className={`goal-status ${tone}`}>{statusText(g, s, (v) => money(roundMoney(v, mainCurrency.decimals)))}</span>
          </span>
        </button>
        {!g.archived && (
          <button className="goal-quick" aria-label={t('goals.quickAdd', { name: g.name })} onClick={() => onAdd({ mode: 'goal', goalDir: 'save', goalId: g.id })}>
            <IconPlus size={20} />
          </button>
        )}
      </div>
    )
  }

  return (
    <main>
      <h1 className="screen-title">{t('goals.title')}</h1>
      {active.length === 0 ? (
        <GoalsEmpty onEdit={onEdit} />
      ) : (
        <>
          <section className="card goals-total">
            <span className="stat-label">{t('goals.total')}</span>
            <span className="goals-total-amount">{money(total)}</span>
            {month !== 0 && <span className="stat-extra">{t('goals.monthNet', { amount: money(month, true) })}</span>}
            {total > 0 && (
              <span className="goals-mix" aria-hidden="true">
                {active.map((g) => (
                  <span key={g.id} style={{ flexGrow: Math.max(0, balances.get(g.id) ?? 0), background: g.color }} />
                ))}
              </span>
            )}
          </section>

          <section className="card goal-list">{active.map(row)}</section>

          <button className="card new-goal" onClick={() => onEdit(null)}>
            <span className="new-goal-plus">+</span>
            <span>
              <span className="goal-name">{t('goals.new')}</span>
              <span className="muted small" style={{ display: 'block' }}>
                {t('goals.newHint')}
              </span>
            </span>
          </button>
        </>
      )}

      {archived.length > 0 && (
        <>
          <button className="section-title as-button" onClick={() => setShowArchived((v) => !v)}>
            {t('goals.archived', { n: archived.length })} {showArchived ? '▾' : '▸'}
          </button>
          {showArchived && <section className="card goal-list">{archived.map(row)}</section>}
        </>
      )}
    </main>
  )
}

interface DetailProps {
  data: AppData
  goal: Goal
  onBack: () => void
  onEdit: () => void
  onAdd: (preset: SheetPreset) => void
  onOpenTx: (tx: Transaction) => void
}

/** Pagina di un gomitolo: numeri, previsione, azioni, accantonamento automatico e storico. */
export function GoalDetail({ data, goal, onBack, onEdit, onAdd, onOpenTx }: DetailProps) {
  const { mainCurrency, transactions, recurring, accounts } = data
  const balances = useMemo(() => goalBalances(transactions), [transactions])
  const s = goalStats(goal, transactions, balances.get(goal.id) ?? 0)
  const money = (v: number, sign = false) => formatMoney(v, mainCurrency, { sign })
  const round = (v: number) => roundMoney(v, mainCurrency.decimals)
  const history = transactions.filter((tx) => tx.goalId === goal.id).reverse()
  const auto = recurring.filter((r) => r.kind === 'save' && r.goalId === goal.id && r.active)
  const [autoAmount, setAutoAmount] = useState(s.needed ? numberToInput(fromMinor(round(s.needed), mainCurrency.decimals)) : '')
  const [autoFreq, setAutoFreq] = useState<Frequency>('month')
  const [autoError, setAutoError] = useState('')

  async function startAuto() {
    const amount = parseTyped(autoAmount, mainCurrency.decimals)
    if (amount <= 0) return setAutoError(t('err.amount'))
    const account = accounts.find((a) => !a.archived && a.currency === mainCurrency.code) ?? accounts[0]
    await createAutoSave(goal.id, amount, mainCurrency.code, account?.id ?? '', autoFreq)
  }

  const kindLabel = (tx: Transaction) =>
    tx.kind === 'save' ? t('goalForm.kindSave') : tx.kind === 'release' ? t('goalForm.kindRelease') : t('goalForm.kindSpent')
  const tone = s.status === 'reached' || s.status === 'onTrack' ? 'good' : s.status === 'behind' || s.status === 'overdue' ? 'bad' : ''

  return (
    <>
      <header className="bar">
        <button className="icon-btn" aria-label={t('common.back')} onClick={onBack}>
          <IconLeft />
        </button>
        <span style={{ fontWeight: 500 }}>{goal.name}</span>
        <button className="icon-btn" aria-label={t('goals.edit')} onClick={onEdit}>
          <IconPencil size={20} />
        </button>
      </header>

      <section className="goal-hero" style={{ '--c': goal.color } as CSSProperties}>
        <YarnBall color={goal.color} progress={goal.target > 0 ? s.progress : s.saved > 0 ? 0.6 : 0} size={132} open={goal.target <= 0} />
        <p className="goal-hero-amount">{money(s.saved)}</p>
        {goal.target > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {t('goals.of', { amount: money(goal.target) })} · {Math.min(100, Math.round(s.progress * 100))}%
          </p>
        )}
        <p className={`goal-status ${tone}`} style={{ marginTop: 6 }}>
          {statusText(goal, s, (v) => money(round(v)))}
        </p>
      </section>

      {s.status === 'reached' && !goal.archived && (
        <div className="card reached">
          <p style={{ margin: '0 0 10px' }}>{t('goals.reachedBanner')}</p>
          <button className="secondary" onClick={() => db.goals.update(goal.id, { archived: true }).then(onBack)}>
            {t('common.archive')}
          </button>
        </div>
      )}

      {!goal.archived && (
        <div className="goal-actions">
          <button className={s.status === 'reached' ? 'secondary' : 'primary'} onClick={() => onAdd({ mode: 'goal', goalDir: 'save', goalId: goal.id })}>
            {t('goals.putAside')}
          </button>
          <button className={s.status === 'reached' ? 'primary' : 'secondary'} onClick={() => onAdd({ mode: 'expense', goalId: goal.id })}>
            {t('goals.spend')}
          </button>
          {s.saved > 0 && (
            <button className="secondary" onClick={() => onAdd({ mode: 'goal', goalDir: 'release', goalId: goal.id })}>
              {t('goals.takeBack')}
            </button>
          )}
        </div>
      )}

      <section className="card stats three">
        <div className="stat">
          <span className="stat-label">{t('goals.toGo')}</span>
          <span className="stat-value">{goal.target > 0 ? money(s.missing) : t('goals.none')}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('goals.needed')}</span>
          <span className="stat-value">{s.needed !== null ? money(round(s.needed)) : t('goals.none')}</span>
          {goal.deadline && <span className="stat-extra">{t('goals.by', { date: monthYear().format(goal.deadline) })}</span>}
        </div>
        <div className="stat">
          <span className="stat-label">{t('goals.pace')}</span>
          <span className="stat-value">{s.pace > 0 ? money(round(s.pace)) : t('goals.none')}</span>
          {s.pace > 0 && (
            <span className="stat-extra">
              {t('goals.aMonth')}
              {s.projected !== null && ` · ${monthYear().format(s.projected)}`}
            </span>
          )}
        </div>
      </section>

      {!goal.archived && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">
              <IconRepeat size={16} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {t('goals.auto')}
            </h2>
          </div>
          {auto.length > 0 ? (
            auto.map((r) => (
              <div key={r.id} className="auto-row">
                <span className="grow">
                  {t('goals.autoOn', { amount: money(r.amount), frequency: t(`repeat.${r.frequency}` as Key).toLowerCase() })}
                  <span className="muted small" style={{ display: 'block' }}>
                    {t('goals.autoNext', { date: dateFmt({ day: 'numeric', month: 'short' }).format(r.next) })}
                  </span>
                </span>
                <button className="secondary slim" onClick={() => updateSeries({ ...r, active: false })}>
                  {t('goals.autoStop')}
                </button>
              </div>
            ))
          ) : (
            <>
              <p className="muted small" style={{ margin: '0 0 10px' }}>
                {t('goals.autoHint')}
              </p>
              <div className="auto-form">
                <input
                  className="input"
                  inputMode="decimal"
                  value={autoAmount}
                  placeholder={formatMoney(10000, mainCurrency)}
                  onChange={(e) => (setAutoAmount(e.target.value), setAutoError(''))}
                  aria-label={t('rec.amount')}
                />
                <select className="input" value={autoFreq} onChange={(e) => setAutoFreq(e.target.value as Frequency)} aria-label={t('rec.frequency')}>
                  {(['week', 'month', 'year'] as const).map((f) => (
                    <option key={f} value={f}>
                      {t(`repeat.${f}` as Key)}
                    </option>
                  ))}
                </select>
                <button className="primary slim" onClick={startAuto}>
                  {t('goals.autoSet')}
                </button>
              </div>
              {autoError && <p className="error">{autoError}</p>}
            </>
          )}
        </section>
      )}

      <p className="section-title">{t('goalForm.history')}</p>
      {history.length === 0 ? (
        <p className="note-box">{t('goals.noHistory')}</p>
      ) : (
        <div className="list">
          {history.map((tx) => (
            <button key={tx.id} className={`list-row${tx.date > Date.now() ? ' archived' : ''}`} onClick={() => onOpenTx(tx)}>
              <span className="grow">
                {kindLabel(tx)}
                {tx.recurringId && <span className="muted small"> · ↻</span>}
                {tx.note && <span className="muted small"> · {tx.note}</span>}
                <span className="muted small" style={{ display: 'block' }}>
                  {shortDate().format(tx.date)}
                </span>
              </span>
              <span className={`legend-value${tx.kind === 'save' ? ' positive' : ''}`}>{money(goalDelta(tx, goal.id), true)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

interface FormProps {
  data: AppData
  goal: Goal | null
  onDone: (saved?: Goal) => void
  template?: GoalTemplate
}

export function GoalForm({ data, goal, onDone, template }: FormProps) {
  const { mainCurrency, goals, transactions } = data
  const [name, setName] = useState(goal?.name ?? template?.name ?? '')
  const [target, setTarget] = useState(goal && goal.target > 0 ? numberToInput(fromMinor(goal.target, mainCurrency.decimals)) : '')
  const [deadline, setDeadline] = useState(() => {
    if (!goal?.deadline) return ''
    const d = new Date(goal.deadline)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [color, setColor] = useState(goal?.color ?? template?.color ?? WOOL[(goals.length * 3 + 5) % WOOL.length])
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const used = goal ? transactions.some((tx) => tx.goalId === goal.id) : false
  const saved = goal ? transactions.reduce((s, tx) => s + goalDelta(tx, goal.id), 0) : 0
  const targetMinor = parseTyped(target, mainCurrency.decimals)

  async function save() {
    if (!name.trim()) return setError(t('goalForm.nameErr'))
    let deadlineTs: number | undefined
    if (deadline) {
      const [y, m] = deadline.split('-').map(Number)
      deadlineTs = new Date(y, m, 0, 23, 59).getTime()
    }
    const next: Goal = {
      id: goal?.id ?? crypto.randomUUID(),
      name: name.trim(),
      target: Math.max(0, targetMinor),
      deadline: deadlineTs,
      color,
      order: goal?.order ?? Math.max(0, ...goals.map((g) => g.order)) + 1,
      archived: goal?.archived ?? false,
    }
    await db.goals.put(next)
    onDone(next)
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

  return (
    <>
      <header className="bar">
        <button className="icon-btn" aria-label={t('common.back')} onClick={() => onDone(goal ?? undefined)}>
          <IconLeft />
        </button>
        <span style={{ fontWeight: 500 }}>{goal ? t('goalForm.edit') : t('goals.new')}</span>
        <span style={{ width: 36 }} />
      </header>

      <div className="goal-preview">
        <YarnBall color={color} progress={targetMinor > 0 ? saved / targetMinor : saved > 0 ? 0.6 : 0.35} size={96} open={targetMinor <= 0} />
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
              .map((sug) => (
                <button key={sug} className="chip ghost" onClick={() => setName(sug)}>
                  {sug}
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

      {goal && !used && (
        <p className="note-box">
          {t('goalForm.empty')}{' '}
          <button className={`danger-link${confirmDelete ? ' armed' : ''}`} style={{ padding: 0 }} onClick={remove}>
            {confirmDelete ? t('goalForm.deleteConfirm') : t('goalForm.deleteIt')}
          </button>
          .
        </p>
      )}
    </>
  )
}
