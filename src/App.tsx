import { useEffect, useMemo, useRef, useState } from 'react'
import { AddSheet, type SheetPreset } from './AddSheet'
import { goalBalances, signedMain, useAppData, type AppData } from './data'
import { db, type Currency, type Goal, type Transaction } from './db'
import { GoalDetail, GoalForm, Goals, type GoalTemplate } from './Goals'
import { builtinName, dateFmt, getLang, readLangSetting, resolveLang, setLang, t, writeLangSetting, type LangSetting } from './i18n'
import { IconFig, IconGear, IconLeft, IconLoom, IconPlus, IconRight, IconThread, IconYarn } from './icons'
import { formatMoney, moneyParts, parseTyped } from './money'
import { migrateInitialBalances, saveOpening } from './opening'
import { Settings } from './Settings'
import { ThreadView } from './ThreadView'
import { Trama } from './Trama'

const DAY = 86_400_000

type Tab = 'filo' | 'trama' | 'goals' | 'settings'

export interface MonthView {
  start: Date
  end: Date
  isCurrent: boolean
  monthTx: Transaction[]
  startBalance: number
  income: number
  expense: number
  /** Netto messo nei gomitoli nel mese (messo da parte meno ripreso). */
  saved: number
  balanceNow: number
  endBalance: number
  forecast: number | null
  /** Quota del mese trascorsa, da 0 a 1. */
  elapsed: number
  daysLeft: number
  /** Quota delle risorse del mese (saldo iniziale + entrate) già uscita dal disponibile. */
  usedShare: number
}

export function computeMonth(data: AppData, monthOffset: number): MonthView {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1)
  const isCurrent = monthOffset === 0

  let startBalance = data.accounts.reduce((sum, a) => sum + a.initialMain, 0)
  const monthTx: Transaction[] = []
  for (const tx of data.transactions) {
    if (tx.date < start.getTime()) startBalance += signedMain(tx)
    else if (tx.date < end.getTime()) monthTx.push(tx)
  }

  let income = 0
  let opening = 0
  let expense = 0
  let saved = 0
  let balanceNow = startBalance
  let spentSoFar = 0
  let outOfPocket = 0
  for (const tx of monthTx) {
    if (tx.kind === 'income') income += tx.mainAmount
    // Il saldo iniziale non è un'entrata, ma fa parte delle risorse del mese.
    if (tx.kind === 'opening') opening += tx.mainAmount
    if (tx.kind === 'expense') expense += tx.mainAmount
    if (tx.kind === 'save') saved += tx.mainAmount
    if (tx.kind === 'release') saved -= tx.mainAmount
    const delta = signedMain(tx)
    if (delta < 0) outOfPocket -= delta
    if (tx.date <= now.getTime()) {
      balanceNow += delta
      // Il ritmo di spesa conta solo le uscite pagate dal disponibile.
      if (tx.kind === 'expense' && !tx.goalId) spentSoFar += tx.mainAmount
    }
  }
  const endBalance = monthTx.reduce((b, tx) => b + signedMain(tx), startBalance)
  const total = end.getTime() - start.getTime()
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / total))
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY))

  // Previsione: il ritmo medio di spesa finora, proiettato sui giorni che mancano,
  // al netto delle uscite già registrate con data futura.
  let forecast: number | null = null
  if (isCurrent && spentSoFar > 0) {
    const elapsedDays = Math.max(1, (now.getTime() - start.getTime()) / DAY)
    const remainingDays = (end.getTime() - now.getTime()) / DAY
    const futureSpent = monthTx
      .filter((t) => t.date > now.getTime() && t.kind === 'expense' && !t.goalId)
      .reduce((s, t) => s + t.mainAmount, 0)
    forecast = Math.round(endBalance - Math.max(0, (spentSoFar / elapsedDays) * remainingDays - futureSpent))
  }

  const pool = startBalance + income + opening
  const usedShare = pool > 0 ? outOfPocket / pool : outOfPocket > 0 ? 1 : 0

  return { start, end, isCurrent, monthTx, startBalance, income, expense, saved, balanceNow, endBalance, forecast, elapsed, daysLeft, usedShare }
}

function BigMoney({ minor, currency }: { minor: number; currency: Currency }) {
  const p = moneyParts(minor, currency)
  const symbol = p.symbolFirst ? `${p.symbol}${p.symbol.length > 1 ? ' ' : ''}` : ` ${p.symbol}`
  return (
    <>
      {p.sign}
      {p.symbolFirst && symbol}
      {p.whole}
      {p.fraction && <span className="cents">{p.fraction}</span>}
      {!p.symbolFirst && symbol}
    </>
  )
}

interface Toast {
  id: number
  text: string
  undo?: () => Promise<unknown>
}

/** Primo avvio: chiede da quanto si parte, altrimenti il disponibile partirebbe da zero. */
function Onboarding({ data, onSkip }: { data: AppData; onSkip: () => void }) {
  const accounts = data.accounts.filter((a) => !a.archived && a.currency === data.mainCurrency.code)
  const [values, setValues] = useState<Record<string, string>>({})

  async function save() {
    // Un nodo "Saldo iniziale" per ogni conto compilato, modificabile dal filo.
    const now = Date.now()
    for (const a of accounts) {
      const v = parseTyped(values[a.id] ?? '', data.mainCurrency.decimals)
      if (v !== 0) await saveOpening(a, v, v, now)
    }
    onSkip()
  }

  return (
    <section className="card onboarding">
      <p className="empty-title" style={{ margin: 0 }}>
        {t('onb.title')}
      </p>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>
        {t('onb.body')}
      </p>
      <div className="form">
        {accounts.map((a) => (
          <label key={a.id} className="field">
            {builtinName(a, 'acc')}
            <input
              inputMode="decimal"
              placeholder={formatMoney(0, data.mainCurrency)}
              value={values[a.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [a.id]: e.target.value }))}
            />
          </label>
        ))}
        <div className="form-actions">
          <button className="secondary" onClick={onSkip}>
            {t('onb.later')}
          </button>
          <button className="primary" onClick={save}>
            {t('onb.start')}
          </button>
        </div>
      </div>
    </section>
  )
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export default function App({ offline = false }: { offline?: boolean }) {
  const data = useAppData()
  const [langSetting, setLangSetting] = useState<LangSetting>(readLangSetting)
  const lang = resolveLang(langSetting)
  // La lingua va impostata prima di disegnare i figli, che leggono le traduzioni.
  if (getLang() !== lang) setLang(lang)
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const [tab, setTab] = useState<Tab>('filo')
  const [monthOffset, setMonthOffset] = useState(0)
  const [sheet, setSheet] = useState<{ editing: Transaction | null; preset?: SheetPreset } | null>(null)
  const [goalForm, setGoalForm] = useState<{ goal: Goal | null; returnTo: Tab; template?: GoalTemplate } | null>(null)
  const [goalDetail, setGoalDetail] = useState<string | null>(null)
  const [freshId, setFreshId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [onboardingDone, setOnboardingDone] = useState(() => readFlag('fig-onboarding'))
  const toastTimer = useRef<number | undefined>(undefined)

  const view = useMemo(() => (data ? computeMonth(data, monthOffset) : null), [data, monthOffset])
  const goalTotal = useMemo(() => {
    if (!data) return 0
    const balances = goalBalances(data.transactions)
    return data.goals.filter((g) => !g.archived).reduce((s, g) => s + (balances.get(g.id) ?? 0), 0)
  }, [data])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // Saldi iniziali delle versioni precedenti (campo nascosto del conto) → nodi sul filo.
  const hasLegacyBalances = !!data?.accounts.some((a) => a.initialBalance !== 0 || a.initialMain !== 0)
  useEffect(() => {
    if (hasLegacyBalances) void migrateInitialBalances()
  }, [hasLegacyBalances])

  if (!data || !view) return <div className="app" />

  const { mainCurrency } = data
  const monthLabel = (d: Date) => dateFmt({ month: 'long', year: 'numeric' }).format(d)
  const monthName = (d: Date) => dateFmt({ month: 'long' }).format(d)

  function changeLang(setting: LangSetting) {
    writeLangSetting(setting)
    setLangSetting(setting)
  }

  function showToast(text: string, undo?: () => Promise<unknown>) {
    window.clearTimeout(toastTimer.current)
    setToast({ id: Date.now(), text, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }

  function describe(tx: Transaction): string {
    const goal = data!.goals.find((g) => g.id === tx.goalId)?.name ?? t('thread.stash')
    const amount = formatMoney(tx.mainAmount, mainCurrency)
    switch (tx.kind) {
      case 'save':
        return t('toast.save', { amount, goal })
      case 'release':
        return t('toast.release', { amount, goal })
      case 'income':
        return t('toast.income', { amount })
      case 'transfer':
        return t('toast.transfer')
      default:
        return tx.goalId ? t('toast.spentFrom', { amount, goal }) : t('toast.expense', { amount })
    }
  }

  function finishOnboarding() {
    try {
      localStorage.setItem('fig-onboarding', '1')
    } catch {
      /* senza storage si richiede al prossimo avvio: va bene lo stesso */
    }
    setOnboardingDone(true)
  }

  const showOnboarding = !onboardingDone && data.transactions.length === 0 && data.accounts.every((a) => a.initialBalance === 0)

  const monthNav = (
    <nav className="month-nav" aria-label={t('nav.month')}>
      <button className="icon-btn" aria-label={t('nav.prevMonth')} onClick={() => setMonthOffset((m) => m - 1)}>
        <IconLeft />
      </button>
      <button className="month-label" onClick={() => setMonthOffset(0)} title={t('nav.currentMonth')}>
        {monthLabel(view.start)}
      </button>
      <button className="icon-btn" aria-label={t('nav.nextMonth')} onClick={() => setMonthOffset((m) => m + 1)}>
        <IconRight />
      </button>
    </nav>
  )

  const sheetEl = sheet && (
    <AddSheet
      data={data}
      editing={sheet.editing}
      preset={sheet.preset}
      onClose={() => setSheet(null)}
      onNewGoal={() => {
        setSheet(null)
        setGoalForm({ goal: null, returnTo: 'goals' })
      }}
      onSaved={(tx, previous) => {
        setSheet(null)
        setFreshId(tx.id)
        showToast(previous ? t('toast.edited') : describe(tx), async () => {
          if (previous) return db.transactions.put(previous)
          // Annullare una nuova ricorrente toglie tutta la serie appena creata.
          const rule = tx.recurringId ? await db.recurring.get(tx.recurringId) : undefined
          if (rule) {
            await db.transactions.where('recurringId').equals(rule.id).delete()
            await db.recurring.delete(rule.id)
          }
          return db.transactions.delete(tx.id)
        })
        // Nel filo porta la vista sul mese del movimento appena salvato.
        if (tab === 'filo' || tab === 'trama') {
          const now = new Date()
          const when = new Date(tx.date)
          setMonthOffset((when.getFullYear() - now.getFullYear()) * 12 + when.getMonth() - now.getMonth())
        }
      }}
      onDeleted={(tx) => {
        setSheet(null)
        showToast(t('toast.deleted'), () => db.transactions.put(tx))
      }}
    />
  )

  const toastEl = toast && (
    <div className="toast" role="status" key={toast.id}>
      <span>{toast.text}</span>
      {toast.undo && (
        <button
          onClick={async () => {
            const undo = toast.undo!
            setToast(null)
            await undo()
          }}
        >
          {t('common.undo')}
        </button>
      )}
    </div>
  )

  if (goalForm) {
    return (
      <div className="app">
        <GoalForm
          data={data}
          goal={goalForm.goal}
          template={goalForm.template}
          onDone={(saved) => {
            setTab(goalForm.returnTo)
            setGoalForm(null)
            // Nuovo gomitolo: si apre la sua pagina. Archiviato o eliminato: si torna alla lista.
            if (saved && !saved.archived) setGoalDetail(saved.id)
            else if (!saved) setGoalDetail(null)
          }}
        />
        {sheetEl}
        {toastEl}
      </div>
    )
  }

  const detailGoal = goalDetail ? data.goals.find((g) => g.id === goalDetail) : undefined
  if (detailGoal) {
    return (
      <div className="app">
        <GoalDetail
          data={data}
          goal={detailGoal}
          onBack={() => setGoalDetail(null)}
          onEdit={() => setGoalForm({ goal: detailGoal, returnTo: 'goals' })}
          onAdd={(preset) => setSheet({ editing: null, preset })}
          onOpenTx={(tx) => setSheet({ editing: tx })}
        />
        {sheetEl}
        {toastEl}
      </div>
    )
  }

  if (tab === 'settings') {
    return (
      <div className="app">
        <Settings data={data} offline={offline} langSetting={langSetting} onLangChange={changeLang} onBack={() => setTab('filo')} />
        {toastEl}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="bar">
        <span className="wordmark">
          <IconFig />
          fig
        </span>
        {tab !== 'goals' ? monthNav : <span />}
        <button className="icon-btn" aria-label={t('nav.settings')} onClick={() => setTab('settings')}>
          <IconGear />
        </button>
      </header>

      {tab === 'filo' && (
        <main>
          {showOnboarding && <Onboarding data={data} onSkip={finishOnboarding} />}
          <section className="hero">
            <p className="hero-label">{view.isCurrent ? t('hero.available') : monthOffset < 0 ? t('hero.endOfMonth') : t('hero.projected')}</p>
            <p className="hero-amount">
              <BigMoney minor={view.isCurrent ? view.balanceNow : view.endBalance} currency={mainCurrency} />
            </p>
            <p className="hero-sub">
              {view.isCurrent && (view.daysLeft <= 1 ? t('hero.lastDay') : t('hero.daysLeft', { n: view.daysLeft }))}
              {view.isCurrent && goalTotal > 0 && ' · '}
              {goalTotal > 0 && (
                <button className="hero-link" onClick={() => setTab('goals')}>
                  {t('hero.inGoals', { amount: formatMoney(goalTotal, mainCurrency) })}
                </button>
              )}
            </p>

            <div className="gauges">
              <div className="gauge">
                <span>{t('hero.elapsed')}</span>
                <span>{Math.round(view.elapsed * 100)}%</span>
                <div className="gauge-track">
                  <div className="gauge-fill" style={{ width: `${view.elapsed * 100}%` }} />
                </div>
              </div>
              <div className="gauge">
                <span>{t('hero.used')}</span>
                <span>{Math.round(view.usedShare * 100)}%</span>
                <div className="gauge-track">
                  <div
                    className={`gauge-fill money${view.usedShare > view.elapsed + 0.05 && view.isCurrent ? ' over' : ''}`}
                    style={{ width: `${Math.min(1, view.usedShare) * 100}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="totals">
              <span>
                <span>{t('hero.income')}</span>
                {formatMoney(view.income, mainCurrency)}
              </span>
              <span>
                <span>{t('hero.expense')}</span>
                {formatMoney(view.expense, mainCurrency)}
              </span>
              {view.saved !== 0 && (
                <span>
                  <span>{t('hero.saved')}</span>
                  {formatMoney(view.saved, mainCurrency)}
                </span>
              )}
            </div>
          </section>

          <ThreadView
            startBalance={view.startBalance}
            monthTx={view.monthTx}
            forecast={view.forecast}
            mainCurrency={mainCurrency}
            currencies={data.currencies}
            categories={data.categories}
            accounts={data.accounts}
            goals={data.goals}
            freshId={freshId}
            onOpen={(tx) => setSheet({ editing: tx })}
          />
          {view.monthTx.length === 0 && (
            <div className="empty">
              <p className="empty-title">{t('empty.title', { month: monthName(view.start) })}</p>
              <p className="muted small">{t('empty.body')}</p>
            </div>
          )}
        </main>
      )}

      {tab === 'trama' && (
        <Trama data={data} view={view} monthOffset={monthOffset} onOpen={(tx) => setSheet({ editing: tx })} onPickMonth={setMonthOffset} />
      )}

      {tab === 'goals' && (
        <Goals
          data={data}
          onAdd={(preset) => setSheet({ editing: null, preset })}
          onOpen={(goal) => setGoalDetail(goal.id)}
          onEdit={(goal, template) => setGoalForm({ goal, returnTo: 'goals', template })}
        />
      )}

      <div className="dock-wrap">
        <nav className="dock" aria-label={t('nav.sections')}>
          <button className={`dock-tab${tab === 'filo' ? ' on' : ''}`} onClick={() => setTab('filo')}>
            <IconThread />
            {t('nav.thread')}
          </button>
          <button className={`dock-tab${tab === 'trama' ? ' on' : ''}`} onClick={() => setTab('trama')}>
            <IconLoom />
            {t('nav.weave')}
          </button>
          <button className={`dock-tab${tab === 'goals' ? ' on' : ''}`} onClick={() => setTab('goals')}>
            <IconYarn />
            {t('nav.goals')}
          </button>
        </nav>
        <button
          className="dock-add"
          aria-label={t('nav.add')}
          onClick={() => setSheet({ editing: null, preset: tab === 'goals' ? { mode: 'goal', goalDir: 'save' } : undefined })}
        >
          <IconPlus />
        </button>
      </div>

      {sheetEl}
      {toastEl}
    </div>
  )
}
