import { useEffect, useMemo, useRef, useState } from 'react'
import { AddSheet, remember, type SheetPreset } from './AddSheet'
import { Calculator } from './Calculator'
import { Reconcile } from './Reconcile'
import { IconAlertTriangle, IconCalculator, IconInfoCircle } from '@tabler/icons-react'
import { accountBalance, goalBalances, placeholderOnly, signedMain, useAppData, type AppData } from './data'
import { db, type Currency, type Goal, type Transaction } from './db'
import { undoStartingBalances } from './firstRun'
import { GoalDetail, GoalForm, Goals, type GoalTemplate } from './Goals'
import { builtinName, dateFmt, getLang, readLangSetting, resolveLang, setLang, t, writeLangSetting, type LangSetting } from './i18n'
import { IconBranch, IconFig, IconFigOutline, IconGear, IconLeft, IconPlus, IconRight, IconTree } from './icons'
import { formatMoney, moneyParts } from './money'
import { SetupCard } from './Onboarding'
import { hasOpening, migrateInitialBalances } from './opening'
import { Settings } from './Settings'
import { ThreadView } from './ThreadView'
import { Trama } from './Trama'
import { authEnabled } from './auth'
import { syncNow, useSyncStatus } from './sync'

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
  /** Come è stata calcolata la previsione, per la spiegazione nel filo. */
  forecastInfo: ForecastInfo | null
  /** Quota del mese trascorsa, da 0 a 1. */
  elapsed: number
  daysLeft: number
  /** Risorse del mese: quanto c'era all'inizio più entrate e saldi iniziali. */
  pool: number
  /** Quota delle risorse del mese già uscita dal disponibile. */
  usedShare: number
}

export interface ForecastInfo {
  /** Spesa media al giorno finora (solo spese di tutti i giorni). */
  perDay: number
  daysLeft: number
  /** Spesa probabile nei giorni che mancano, al netto di quella già registrata con data futura. */
  projected: number
  /** Uscite lasciate fuori dal ritmo: ricorrenti, allineamenti, spese eccezionali. */
  excluded: number
}

/** Spese "di tutti i giorni": né ricorrenti, né allineamenti, né pagate da un gomitolo. */
function isEveryday(tx: Transaction): boolean {
  return tx.kind === 'expense' && !tx.goalId && !tx.recurringId && tx.source !== 'adjust'
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
    }
  }
  const endBalance = monthTx.reduce((b, tx) => b + signedMain(tx), startBalance)
  const total = end.getTime() - start.getTime()
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / total))
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY))

  // Previsione: il ritmo medio delle spese di tutti i giorni finora, proiettato sui giorni che mancano,
  // al netto di quelle già registrate con data futura. Ricorrenti e allineamenti sono già nel saldo
  // o non si ripetono; le spese eccezionali (oltre 4 volte la mediana) non fanno ritmo.
  let forecast: number | null = null
  let forecastInfo: ForecastInfo | null = null
  const past = monthTx.filter((tx) => tx.date <= now.getTime() && tx.kind === 'expense' && !tx.goalId)
  const everyday = past.filter(isEveryday)
  if (isCurrent && everyday.length > 0) {
    const sorted = everyday.map((tx) => tx.mainAmount).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const cap = sorted.length >= 4 ? median * 4 : Infinity
    const spentSoFar = everyday.filter((tx) => tx.mainAmount <= cap).reduce((s, tx) => s + tx.mainAmount, 0)
    const excluded = past.reduce((s, tx) => s + tx.mainAmount, 0) - spentSoFar
    const elapsedDays = Math.max(1, (now.getTime() - start.getTime()) / DAY)
    const remainingDays = (end.getTime() - now.getTime()) / DAY
    const futureSpent = monthTx.filter((t) => t.date > now.getTime() && isEveryday(t)).reduce((s, t) => s + t.mainAmount, 0)
    const perDay = spentSoFar / elapsedDays
    const projected = Math.round(Math.max(0, perDay * remainingDays - futureSpent))
    forecast = endBalance - projected
    forecastInfo = { perDay: Math.round(perDay), daysLeft: Math.ceil(remainingDays), projected, excluded }
  }

  const pool = startBalance + income + opening
  const usedShare = pool > 0 ? outOfPocket / pool : outOfPocket > 0 ? 1 : 0

  return { start, end, isCurrent, monthTx, startBalance, income, expense, saved, balanceNow, endBalance, forecast, forecastInfo, elapsed, daysLeft, pool, usedShare }
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

export default function App({ offline = false, local = false }: { offline?: boolean; local?: boolean }) {
  const data = useAppData()
  const [langSetting, setLangSetting] = useState<LangSetting>(readLangSetting)
  const lang = resolveLang(langSetting)
  // La lingua va impostata prima di disegnare i figli, che leggono le traduzioni.
  if (getLang() !== lang) setLang(lang)
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const [tab, setTabState] = useState<Tab>(() => {
    const saved = remember.get('fig-tab')
    return saved === 'trama' || saved === 'goals' ? saved : 'filo'
  })
  const setTab = (next: Tab) => {
    setTabState(next)
    if (next !== 'settings') remember.set('fig-tab', next)
  }
  const [monthOffset, setMonthOffset] = useState(0)
  const [calcOpen, setCalcOpen] = useState(false)
  const [reconcileId, setReconcileIdRaw] = useState<string | null>(null)
  // Scorciatoia "Nuovo movimento" dall'icona dell'app (?add=1): si apre subito l'inserimento.
  const [sheet, setSheetRaw] = useState<{ editing: Transaction | null; preset?: SheetPreset } | null>(() =>
    new URLSearchParams(location.search).has('add') ? { editing: null } : null,
  )
  useEffect(() => {
    // Tolti i parametri di avvio (?add, ?source): un ricaricamento non riapre l'inserimento.
    if (location.search) history.replaceState(null, '', location.pathname)
  }, [])
  const [goalForm, setGoalFormRaw] = useState<{ goal: Goal | null; returnTo: Tab; template?: GoalTemplate } | null>(null)
  const [goalDetail, setGoalDetail] = useState<string | null>(null)
  const syncStatus = useSyncStatus()
  const [freshId, setFreshId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  // Riquadro dei saldi iniziali riaperto a mano dopo "Più tardi".
  const [setupOpen, setSetupOpen] = useState(false)
  const [heroInfo, setHeroInfo] = useState(false)
  const heroRef = useRef<HTMLElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const view = useMemo(() => (data ? computeMonth(data, monthOffset) : null), [data, monthOffset])
  const goalTotal = useMemo(() => {
    if (!data) return 0
    const balances = goalBalances(data.transactions)
    return data.goals.filter((g) => !g.archived).reduce((s, g) => s + (balances.get(g.id) ?? 0), 0)
  }, [data])

  // Saldi dei conti per la card iniziale: un conto in negativo di solito vuol dire un movimento sbagliato o mancante.
  const heroAccounts = useMemo(
    () => (data ? data.accounts.filter((a) => !a.archived).map((account) => ({ account, balance: accountBalance(account, data) })) : []),
    [data],
  )

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  // Scorciatoia "Nuovo movimento" su un dispositivo che ha ancora solo dati predefiniti: l'inserimento non si apre.
  const blockedNow = !!data && placeholderOnly(data)
  useEffect(() => {
    if (blockedNow) setSheetRaw((s) => (s && !s.editing ? null : s))
  }, [blockedNow])
  useEffect(() => {
    // Le versioni precedenti ricordavano il riquadro iniziale nel browser: ora la risposta sta nelle impostazioni dell'utente.
    try {
      localStorage.removeItem('fig-onboarding')
    } catch {
      /* memoria non disponibile: non c'è niente da togliere */
    }
  }, [])

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

  // Sul dispositivo ci sono solo dati predefiniti e l'archivio dell'account deve ancora arrivare: un movimento
  // scritto adesso nascerebbe nella valuta stimata, su conti vuoti. Inserimento, allineamento e nuovi obiettivi aspettano.
  const blocked = placeholderOnly(data)
  function unlessBlocked<T>(open: (value: T) => void) {
    return (value: T) => {
      if (value !== null && blocked) return showToast(t('sync.archivePending'))
      open(value)
    }
  }
  const setSheet = unlessBlocked(setSheetRaw)
  const setReconcileId = unlessBlocked(setReconcileIdRaw)
  const setGoalForm = unlessBlocked(setGoalFormRaw)

  function describe(tx: Transaction): string {
    const goalObj = data!.goals.find((g) => g.id === tx.goalId)
    const goal = goalObj?.name ?? t('thread.stash')
    const amount = formatMoney(tx.mainAmount, mainCurrency)
    switch (tx.kind) {
      case 'save': {
        // Raccolta: questo accantonamento porta l'obiettivo al traguardo.
        if (goalObj && goalObj.target > 0) {
          const before = goalBalances(data!.transactions.filter((x) => x.id !== tx.id)).get(goalObj.id) ?? 0
          if (before < goalObj.target && before + tx.mainAmount >= goalObj.target) return t('toast.harvest', { goal })
        }
        return t('toast.save', { amount, goal })
      }
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

  // ——— Primo avvio ———
  // I saldi iniziali non sono movimenti "veri": finché ci sono solo quelli l'app è ancora da cominciare.
  const realTx = data.transactions.filter((tx) => tx.kind !== 'opening')
  const firstUse = realTx.length === 0
  const anyOpening = realTx.length < data.transactions.length
  // La domanda sul saldo di partenza è ancora aperta: nessuna risposta e nessun saldo iniziale. Finché l'archivio
  // dell'account non è stato scaricato (archivePending) si vedono solo dati predefiniti, quindi non vale.
  const setupPending = !data.archivePending && data.setup !== 'done' && !anyOpening && data.accounts.some((a) => !a.archived && a.currency === mainCurrency.code)
  // Riquadro e riga compaiono solo dopo la sincronizzazione di questa sessione: la risposta potrebbe essere già
  // stata data su un altro dispositivo, e una data qui su dati vecchi la sovrascriverebbe dappertutto. Vale anche
  // per una sessione partita senza rete; senza account non c'è niente da aspettare.
  const dataReady = local || !authEnabled() || syncStatus.lastSync !== null
  const needsSetup = dataReady && setupPending
  // Da solo compare una volta, a chi ha appena cominciato; dopo "Più tardi" resta una riga discreta che lo riapre.
  const showSetup = needsSetup && (setupOpen || (data.setup === undefined && realTx.length < 10))
  // Ai primi movimenti, senza un punto di partenza, una previsione di fine mese direbbe solo quanto si è speso.
  const hideForecast = setupPending && realTx.length < 10

  // Un conto in negativo di solito è un movimento sbagliato o mancante. Se però non ha mai avuto
  // un saldo iniziale non è un errore: manca il punto di partenza, e lo si dice così.
  const overdrawn = heroAccounts.filter((a) => a.balance < 0 && hasOpening(a.account.id, data.transactions))
  const noStart = setupPending ? [] : heroAccounts.filter((a) => a.balance < 0 && !hasOpening(a.account.id, data.transactions))
  const hasGoals = data.goals.some((g) => !g.archived)

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
      onAlign={(accountId) => {
        setSheet(null)
        setReconcileId(accountId)
      }}
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
        <Settings data={data} offline={offline} local={local} langSetting={langSetting} onLangChange={changeLang} onBack={() => setTab('filo')} />
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
        <span className="bar-actions">
          <button className="icon-btn" aria-label={t('calc.title')} onClick={() => setCalcOpen(true)}>
            <IconCalculator size={22} stroke={1.6} />
          </button>
          <button className="icon-btn" aria-label={t('nav.settings')} onClick={() => setTab('settings')}>
            <IconGear />
          </button>
        </span>
      </header>
      {reconcileId && data.accounts.some((a) => a.id === reconcileId) && (
        <Reconcile
          data={data}
          account={data.accounts.find((a) => a.id === reconcileId)!}
          onClose={() => setReconcileId(null)}
          onSaved={(tx) => {
            setFreshId(tx.id)
            showToast(t(tx.kind === 'opening' ? 'align.startSet' : 'align.done'), () => db.transactions.delete(tx.id))
          }}
        />
      )}
      {calcOpen && (
        <Calculator
          onClose={() => setCalcOpen(false)}
          onUse={(amount) => {
            setCalcOpen(false)
            setSheet({ editing: null, preset: { mode: 'expense', amount } })
          }}
        />
      )}

      {tab === 'filo' && (
        <main>
          <h1 className="sr-only">
            {t('nav.thread')}: {monthLabel(view.start)}
          </h1>
          {data.archivePending && (
            <section className="card notice" role="status">
              {/* Dati predefiniti in attesa dell'archivio, oppure dati veri (usati senza account) in attesa di essere caricati. */}
              <p>
                {t(
                  offline || syncStatus.state === 'offline'
                    ? blocked
                      ? 'sync.archiveOffline'
                      : 'sync.uploadOffline'
                    : blocked
                      ? 'sync.archivePending'
                      : 'sync.uploadPending',
                )}
              </p>
              {/* Resta al suo posto anche mentre riprova, così la pagina non salta. */}
              {!offline && (
                <button className="secondary" disabled={syncStatus.state === 'syncing'} onClick={() => void syncNow()}>
                  {t('auth.retry')}
                </button>
              )}
            </section>
          )}
          {showSetup && (
            <SetupCard
              data={data}
              local={local}
              // Sempre il disponibile di oggi, anche se si sta guardando un altro mese: è quello che cambia salvando.
              available={view.isCurrent ? view.balanceNow : computeMonth(data, 0).balanceNow}
              // Il riquadro sparisce: chi usa la tastiera o un lettore di schermo riparte dal disponibile, non dall'inizio della pagina.
              onClose={
                setupOpen
                  ? () => {
                      setSetupOpen(false)
                      heroRef.current?.focus()
                    }
                  : undefined
              }
              onDismissed={() => heroRef.current?.focus()}
              onSaved={(ids, previous) => {
                setSetupOpen(false)
                heroRef.current?.focus()
                if (ids.length === 0) return
                setMonthOffset(0)
                setFreshId(ids[0])
                showToast(t('onb.saved'), () => undoStartingBalances(ids, previous))
              }}
            />
          )}
          <section className="hero" ref={heroRef} tabIndex={-1}>
            <p className="hero-label">
              {view.isCurrent ? t('hero.available') : monthOffset < 0 ? t('hero.endOfMonth') : t('hero.projected')}
              {view.isCurrent && (
                <button className="info-btn hero-info" aria-label={t('hero.availableWhat')} aria-expanded={heroInfo} onClick={() => setHeroInfo((v) => !v)}>
                  <IconInfoCircle size={16} />
                </button>
              )}
            </p>
            <p className="hero-amount">
              <BigMoney minor={view.isCurrent ? view.balanceNow : view.endBalance} currency={mainCurrency} />
            </p>
            {view.isCurrent && heroInfo && (
              <p className="hero-note" role="note">
                {t('hero.availableHow')}
              </p>
            )}
            <p className="hero-sub">
              {view.isCurrent && (view.daysLeft <= 1 ? t('hero.lastDay') : t('hero.daysLeft', { n: view.daysLeft }))}
              {view.isCurrent && goalTotal > 0 && ' · '}
              {goalTotal > 0 && (
                <button className="hero-link" onClick={() => setTab('goals')}>
                  {t('hero.inGoals', { amount: formatMoney(goalTotal, mainCurrency) })}
                </button>
              )}
            </p>

            {/* Senza movimenti le barre e i totali del mese sarebbero solo zeri: compaiono col primo. */}
            {!firstUse && (
              <>
                <div className="gauges">
                  <div className="gauge">
                    <span>{t('hero.elapsed')}</span>
                    <span>{Math.round(view.elapsed * 100)}%</span>
                    <div className="gauge-track">
                      <div className="gauge-fill" style={{ width: `${view.elapsed * 100}%` }} />
                    </div>
                  </div>
                  {/* Senza risorse (niente saldo iniziale né entrate) non c'è una quota da mostrare: sarebbe sempre "100% usato". */}
                  {view.pool > 0 && (
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
                  )}
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
              </>
            )}

            {heroAccounts.length > 0 && (
              <div className="hero-accounts">
                {heroAccounts.map(({ account, balance }) => {
                  const name = builtinName(account, 'acc')
                  const amount = formatMoney(balance, data.currencies.find((c) => c.code === account.currency) ?? mainCurrency)
                  return (
                    <button key={account.id} className="hero-account" aria-label={`${name}: ${amount}. ${t('align.cta')}`} onClick={() => setReconcileId(account.id)}>
                      <span>{name}</span>
                      <span className={balance < 0 ? 'negative' : undefined}>{amount}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {view.isCurrent && needsSetup && !showSetup && (
              <p className="hero-setup">
                {t('hero.noStartingBalance')}{' '}
                <button className="hero-warn-link" onClick={() => setSetupOpen(true)}>
                  {t('hero.setStart')}
                </button>
              </p>
            )}
            {view.isCurrent && overdrawn.length > 0 && (
              <p className="hero-warn" role="alert">
                <IconAlertTriangle size={18} stroke={1.8} />
                <span>
                  {t(overdrawn.length === 1 ? 'hero.overdrawn' : 'hero.overdrawnMany', {
                    name: builtinName(overdrawn[0].account, 'acc'),
                    n: overdrawn.length,
                  })}{' '}
                  <button className="hero-warn-link" onClick={() => setReconcileId(overdrawn[0].account.id)}>
                    {t('align.cta')}
                  </button>
                </span>
              </p>
            )}
            {view.isCurrent && overdrawn.length === 0 && noStart.length > 0 && (
              <p className="hero-warn" role="status">
                <IconAlertTriangle size={18} stroke={1.8} />
                <span>
                  {t('hero.noStart', { name: builtinName(noStart[0].account, 'acc') })}{' '}
                  <button className="hero-warn-link" onClick={() => setReconcileId(noStart[0].account.id)}>
                    {t('hero.setStart')}
                  </button>
                </span>
              </p>
            )}
          </section>

          <ThreadView
            startBalance={view.startBalance}
            monthTx={view.monthTx}
            forecast={hideForecast ? null : view.forecast}
            forecastInfo={hideForecast ? null : view.forecastInfo}
            mainCurrency={mainCurrency}
            currencies={data.currencies}
            categories={data.categories}
            accounts={data.accounts}
            goals={data.goals}
            freshId={freshId}
            legend={realTx.length > 0 && realTx.length <= 5}
            onOpen={(tx) => setSheet({ editing: tx })}
          />
          {/* Il saldo iniziale è un movimento, ma un mese che ha solo quello è ancora vuoto. */}
          {view.monthTx.every((tx) => tx.kind === 'opening') && (
            <div className="empty">
              <p className="empty-title">{t('empty.title', { month: monthName(view.start) })}</p>
              <p className="muted small">{t(firstUse ? 'empty.first' : 'empty.body')}</p>
              {/* Una cosa alla volta: finché c'è il riquadro dei saldi, il passo successivo aspetta. */}
              {firstUse && !showSetup && !(setupPending && data.setup === undefined) && !data.archivePending && (
                <button className="primary" onClick={() => setSheet({ editing: null })}>
                  {t('empty.cta')}
                </button>
              )}
            </div>
          )}
        </main>
      )}

      {tab === 'trama' && (
        <Trama
          data={data}
          view={view}
          monthOffset={monthOffset}
          onOpen={(tx) => setSheet({ editing: tx })}
          onPickMonth={setMonthOffset}
          onAdd={() => setSheet({ editing: null })}
        />
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
          <button className={`dock-tab${tab === 'filo' ? ' on' : ''}`} aria-current={tab === 'filo' ? 'page' : undefined} onClick={() => setTab('filo')}>
            <IconBranch />
            {t('nav.thread')}
          </button>
          <button className={`dock-tab${tab === 'goals' ? ' on' : ''}`} aria-current={tab === 'goals' ? 'page' : undefined} onClick={() => setTab('goals')}>
            <IconFigOutline />
            {t('nav.goals')}
          </button>
          <button className={`dock-tab${tab === 'trama' ? ' on' : ''}`} aria-current={tab === 'trama' ? 'page' : undefined} onClick={() => setTab('trama')}>
            <IconTree />
            {t('nav.weave')}
          </button>
        </nav>
        <button
          className="dock-add"
          aria-label={tab === 'goals' && !hasGoals ? t('goals.createCta') : t('nav.add')}
          onClick={() => {
            // Negli Obiettivi il "+" mette da parte; senza obiettivi non c'è dove, quindi ne crea uno.
            if (tab !== 'goals') setSheet({ editing: null })
            else if (hasGoals) setSheet({ editing: null, preset: { mode: 'goal', goalDir: 'save' } })
            else setGoalForm({ goal: null, returnTo: 'goals' })
          }}
        >
          <IconPlus />
        </button>
      </div>

      {sheetEl}
      {toastEl}
    </div>
  )
}
