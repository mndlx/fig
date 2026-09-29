import { IconArrowLeft, IconBackspace, IconCalculator, IconCalendar, IconCheck, IconChevronDown, IconChevronRight, IconScale, IconNote, IconPigMoney, IconPlus, IconRepeat, IconWallet, IconX } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CategoryIcon } from './catIcons'
import { accountBalance, goalBalances, goalDelta, type AppData } from './data'
import { db, WOOL, type Frequency, type Kind, type Transaction } from './db'
import { createSeries } from './recurring'
import { YarnBall } from './Goals'
import { Calculator } from './Calculator'
import { builtinName, dateFmt, decimalSep, t, type Key } from './i18n'
import { convertMinor, fetchRate, formatMoney, fromMinor, moneyParts, parseInput } from './money'
import { rankCategories } from './suggest'

type Mode = 'expense' | 'income' | 'goal' | 'transfer' | 'opening'
type Step = 'pick' | 'amount'
type Picker = 'date' | 'account' | 'currency' | 'payFrom' | 'note' | 'newCat' | 'repeat' | null
type Repeat = 'none' | Frequency
const REPEATS: Repeat[] = ['none', 'week', 'month', 'year']

export interface SheetPreset {
  mode: Exclude<Mode, 'opening'>
  goalDir?: 'save' | 'release'
  goalId?: string
  /** Importo già pronto (per esempio dalla calcolatrice), in unità intere della valuta. */
  amount?: number
}

interface Props {
  data: AppData
  editing: Transaction | null
  preset?: SheetPreset
  onClose: () => void
  onSaved: (tx: Transaction, previous: Transaction | null) => void
  onDeleted: (tx: Transaction) => void
  onNewGoal: () => void
  /** Apre l'allineamento del saldo sul conto indicato. */
  onAlign?: (accountId: string) => void
}

const MODES: Exclude<Mode, 'opening'>[] = ['expense', 'income', 'goal', 'transfer']
const QUICK_ICONS = ['dots', 'cart', 'kitchen', 'coffee', 'car', 'plane', 'gym', 'pet', 'book', 'movie', 'gift', 'health', 'phone', 'bag']

const PICK_TITLE: Record<Exclude<Mode, 'opening'>, Key> = {
  expense: 'add.q.expense',
  income: 'add.q.income',
  goal: 'add.q.goal',
  transfer: 'add.q.transfer',
}

function toDateInput(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Importo salvato → stringa del tastierino (sempre con "." come separatore interno). */
function inputFromMinor(minor: number, decimals: number): string {
  const text = fromMinor(Math.abs(minor), decimals).toFixed(decimals)
  if (decimals === 0) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

function modeOf(kind: Kind): Mode {
  return kind === 'save' || kind === 'release' ? 'goal' : kind
}

/** Scelte ricordate tra un inserimento e l'altro (solo su questo dispositivo). */
export const ACCOUNT_KEY = 'fig-last-account'
const MODE_KEY = 'fig-last-mode'
export const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Memoria non disponibile (navigazione privata): si riparte dai valori predefiniti.
    }
  },
}
function rememberedMode(): Mode {
  const m = remember.get(MODE_KEY)
  return m === 'income' || m === 'transfer' ? m : 'expense'
}

/**
 * Inserimento in due passi:
 * 1. "Per cosa?": categoria, gomitolo o conto di destinazione, a schermo pieno;
 * 2. "Quanto?": importo col tastierino, dettagli facoltativi e Salva.
 * In modifica si parte dal passo 2; la scelta fatta resta in alto e toccandola si torna al passo 1.
 */
export function AddSheet({ data, editing, preset, onClose, onSaved, onDeleted, onNewGoal, onAlign }: Props) {
  const { accounts, categories, currencies, mainCurrency, transactions, goals } = data
  const activeAccounts = accounts.filter((a) => !a.archived)
  const activeGoals = goals.filter((g) => !g.archived)
  const balances = useMemo(() => goalBalances(transactions), [transactions])
  const accName = (id?: string) => {
    const a = accounts.find((x) => x.id === id)
    return a ? builtinName(a, 'acc') : '?'
  }

  const [mode, setMode] = useState<Mode>(editing ? modeOf(editing.kind) : (preset?.mode ?? rememberedMode()))
  const [goalDir, setGoalDir] = useState<'save' | 'release'>(editing?.kind === 'release' ? 'release' : (preset?.goalDir ?? 'save'))
  const [selected, setSelected] = useState<string | null>(() => {
    if (editing) {
      if (editing.kind === 'transfer') return editing.toAccountId ?? null
      if (editing.kind === 'save' || editing.kind === 'release') return editing.goalId ?? null
      if (editing.kind === 'opening') return editing.accountId
      return editing.categoryId ?? null
    }
    if (preset?.mode === 'goal') return preset.goalId ?? null
    return null
  })
  const [step, setStep] = useState<Step>(selected ? 'amount' : 'pick')
  const [payFrom, setPayFrom] = useState<string | null>(
    editing ? (editing.kind === 'expense' ? (editing.goalId ?? null) : null) : preset?.mode === 'expense' ? (preset.goalId ?? null) : null,
  )
  const [accountId, setAccountId] = useState(
    editing?.accountId ?? activeAccounts.find((a) => a.id === remember.get(ACCOUNT_KEY))?.id ?? activeAccounts[0]?.id ?? '',
  )
  const [currencyCode, setCurrencyCode] = useState(editing?.currency ?? accounts.find((a) => a.id === accountId)?.currency ?? mainCurrency.code)
  const pickedCurrency = currencies.find((c) => c.code === currencyCode) ?? mainCurrency
  // I gomitoli sono sempre nella valuta principale.
  const currency = mode === 'goal' ? mainCurrency : pickedCurrency
  const [input, setInput] = useState(
    editing ? inputFromMinor(editing.amount, currency.decimals) : preset?.amount ? String(Number(preset.amount.toFixed(currency.decimals))) : '',
  )
  const [calc, setCalc] = useState(false)
  const [negative, setNegative] = useState(editing?.kind === 'opening' && editing.amount < 0)
  const [date, setDate] = useState(toDateInput(editing?.date ?? Date.now()))
  const [note, setNote] = useState(editing?.note ?? '')
  const [rate, setRate] = useState(editing && editing.currency !== mainCurrency.code ? String(Math.abs(editing.rate)) : '')
  const [picker, setPicker] = useState<Picker>(null)
  const [repeat, setRepeat] = useState<Repeat>('none')
  const [newCat, setNewCat] = useState({ name: '', icon: 'dots' })
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [drag, setDrag] = useState(0)
  const dragStart = useRef<number | null>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  const foreign = currency.code !== mainCurrency.code
  const kind: Kind = mode === 'goal' ? goalDir : mode

  useEffect(() => {
    if (!foreign) return
    let cancelled = false
    fetchRate(currency.code, mainCurrency.code, new Date(date)).then((r) => {
      if (!cancelled && r !== null) setRate(String(Number(r.toFixed(6))))
    })
    return () => {
      cancelled = true
    }
  }, [foreign, currency.code, mainCurrency.code, date])

  const catKind = mode === 'income' ? 'income' : 'expense'
  const { ranked, fromHabits } = useMemo(
    () => rankCategories(categories.filter((c) => c.kind === catKind && !c.archived), transactions, new Date()),
    [categories, transactions, catKind],
  )
  const suggested = fromHabits ? ranked.slice(0, 4) : []
  const rest = fromHabits ? ranked.slice(4) : ranked

  function switchMode(m: Exclude<Mode, 'opening'>) {
    setMode(m)
    if (m !== 'goal') remember.set(MODE_KEY, m)
    setSelected(null)
    setError('')
    setPicker(null)
  }

  /** Scelta fatta: si passa all'importo. */
  function choose(id: string) {
    setSelected(id)
    setError('')
    setPicker(null)
    setStep('amount')
  }

  function press(key: string) {
    if (step !== 'amount') return
    setError('')
    setInput((prev) => {
      if (key === '⌫') return prev.slice(0, -1)
      if (key === '.') {
        if (currency.decimals === 0 || prev.includes('.')) return prev
        return (prev || '0') + '.'
      }
      const [int, dec] = prev.split('.')
      if (dec !== undefined && dec.length >= currency.decimals) return prev
      if (dec === undefined && int.length >= 9) return prev
      if (prev === '0') return key
      return prev + key
    })
  }

  // Tastiera fisica, utile da PC.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') return onClose()
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (e.key === ',' || e.key === '.') press('.')
      else if (e.key === 'Backspace') press('⌫')
      else if (e.key === 'Enter' && step === 'amount') save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function save() {
    if (!selected) return setStep('pick')
    const amount = parseInput(input, currency.decimals) * (mode === 'opening' && negative ? -1 : 1)
    if (amount === 0 || (mode !== 'opening' && amount < 0)) return setError(t('err.amount'))
    if (kind === 'transfer' && selected === accountId) return setError(t('err.sameAccount'))
    const rateValue = foreign ? Number(rate.replace(',', '.')) : 1
    if (!(rateValue > 0)) return setError(t('err.rate', { from: currency.code, to: mainCurrency.code }))
    if (kind === 'release') {
      const available = (balances.get(selected) ?? 0) + (editing?.kind === 'release' && editing.goalId === selected ? editing.mainAmount : 0)
      if (amount > available) return setError(t('add.goalBalance', { amount: formatMoney(available, mainCurrency) }))
    }

    // Modifica con la stessa data: si tiene l'istante originale, così l'ordine non cambia.
    // Nuovo movimento di oggi: ora attuale. Altro giorno: mezzogiorno (o l'ora originale se si modifica).
    const [y, m, d] = date.split('-').map(Number)
    let when: Date
    if (editing && toDateInput(editing.date) === date) when = new Date(editing.date)
    else if (!editing && toDateInput(Date.now()) === date) when = new Date()
    else {
      const base = editing ? new Date(editing.date) : null
      when = new Date(y, m - 1, d, base ? base.getHours() : 12, base ? base.getMinutes() : 0)
    }

    const tx: Transaction = {
      id: editing?.id ?? crypto.randomUUID(),
      kind,
      amount,
      currency: currency.code,
      rate: rateValue,
      mainAmount: foreign ? Math.sign(amount) * convertMinor(Math.abs(amount), currency, mainCurrency, rateValue) : amount,
      date: when.getTime(),
      categoryId: kind === 'expense' || kind === 'income' ? selected : undefined,
      accountId: mode === 'opening' ? selected : accountId,
      toAccountId: kind === 'transfer' ? selected : undefined,
      goalId: mode === 'goal' ? selected : kind === 'expense' ? (payFrom ?? undefined) : undefined,
      note: note.trim(),
      source: editing?.source ?? 'manual',
      importId: editing?.importId,
      recurringId: editing?.recurringId,
    }
    await db.transactions.put(tx)
    // Ripetizione: il movimento appena salvato diventa la prima scadenza della serie.
    const saved = !editing && repeat !== 'none' ? await createSeries(tx, repeat) : tx
    navigator.vibrate?.(8)
    onSaved(saved, editing)
  }

  async function createCategory() {
    const name = newCat.name.trim()
    if (!name) return setError(t('err.name'))
    const id = crypto.randomUUID()
    const used = new Set(categories.map((c) => c.color))
    await db.categories.add({
      id,
      name,
      icon: newCat.icon,
      kind: catKind,
      color: WOOL.find((c) => !used.has(c)) ?? WOOL[categories.length % WOOL.length],
      order: Math.max(0, ...categories.map((c) => c.order)) + 1,
      archived: false,
    })
    setNewCat({ name: '', icon: 'dots' })
    choose(id)
  }

  async function remove() {
    if (!editing) return
    if (!confirmDelete) return setConfirmDelete(true)
    await db.transactions.delete(editing.id)
    onDeleted(editing)
  }

  // ——— Importo ———
  const amountMinor = parseInput(input, currency.decimals)
  // Guardia: il conto da cui escono i soldi andrebbe sotto zero? Di solito è un errore di contabilità.
  const outAccount = kind === 'expense' || kind === 'transfer' ? accounts.find((a) => a.id === accountId) : undefined
  // Saldo del conto prima di questo movimento (in modifica il movimento è già nel saldo: lo si toglie).
  const accountLeft = (() => {
    if (!outAccount || outAccount.currency !== currency.code) return null
    let balance = accountBalance(outAccount, data)
    if (editing && editing.accountId === outAccount.id && editing.date <= Date.now() && editing.currency === currency.code) balance += editing.amount
    return balance
  })()
  const overdraft =
    accountLeft !== null && amountMinor > 0 && new Date(date).getTime() <= Date.now() && accountLeft - amountMinor < 0 ? accountLeft - amountMinor : null
  // Quanto resta in un gomitolo, senza contare il movimento che si sta modificando.
  const goalLeft = (id: string) => (balances.get(id) ?? 0) - (editing ? goalDelta(editing, id) : 0)
  // "Usa tutto": il gomitolo da cui si paga o si riprende, altrimenti il conto da cui escono i soldi.
  const useAll = (() => {
    if (kind === 'expense' && payFrom) return currency.code === mainCurrency.code ? goalLeft(payFrom) : null
    if (kind === 'release' && selected) return goalLeft(selected)
    return accountLeft
  })()
  const payFromGoal = activeGoals.find((g) => g.id === payFrom)
  // Guardia sui gomitoli: non si può spendere o riprendere più di quanto c'è dentro.
  const sourceGoal = kind === 'expense' && payFrom ? payFromGoal : kind === 'release' ? activeGoals.find((g) => g.id === selected) : undefined
  const goalShort = sourceGoal && useAll !== null && amountMinor > Math.max(0, useAll) ? { goal: sourceGoal, left: Math.max(0, useAll) } : null
  const shown = moneyParts(amountMinor, currency)
  const typed = (negative ? '−' : '') + (input ? input.replace('.', decimalSep()) : '0')
  const amountText = shown.symbolFirst ? `${shown.symbol}${shown.symbol.length > 1 ? ' ' : ''}${typed}` : `${typed} ${shown.symbol}`

  // ——— Scelta fatta, per il riepilogo in alto nel passo 2 ———
  let chosen: { label: string; color: string; icon: ReactNode } | null = null
  if (selected && (mode === 'expense' || mode === 'income')) {
    const c = categories.find((x) => x.id === selected)
    if (c) chosen = { label: builtinName(c, 'cat'), color: c.color, icon: <CategoryIcon name={c.icon} size={18} /> }
  } else if (selected && mode === 'goal') {
    const g = goals.find((x) => x.id === selected)
    if (g) chosen = { label: `${goalDir === 'save' ? t('add.putAside') : t('add.takeBack')} · ${g.name}`, color: g.color, icon: <YarnBall color={g.color} progress={0.6} size={22} /> }
  } else if (selected && mode === 'transfer') {
    chosen = { label: `${accName(accountId)} → ${accName(selected)}`, color: 'var(--thread)', icon: <IconWallet size={18} /> }
  }

  // ——— Pillole di contesto ———
  const todayKey = toDateInput(Date.now())
  const yesterdayKey = toDateInput(Date.now() - 86_400_000)
  const dateLabel =
    (date === todayKey ? t('common.today') : date === yesterdayKey ? t('common.yesterday') : dateFmt({ day: 'numeric', month: 'short' }).format(new Date(date))).replace(/^./, (ch) => ch.toUpperCase())
  const accent = chosen?.color ?? 'var(--fig)'

  const tile = (id: string, label: string, color: string, icon: ReactNode, sub?: string) => (
    <button key={id} className={`tile${selected === id ? ' on' : ''}`} style={{ '--c': color } as CSSProperties} onClick={() => choose(id)}>
      {icon}
      <span className="tile-name">{label}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </button>
  )
  const catTile = (c: (typeof categories)[number]) =>
    tile(
      c.id,
      builtinName(c, 'cat'),
      c.color,
      <span className="tile-icon">
        <CategoryIcon name={c.icon} />
      </span>,
    )

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="sheet add"
        role="dialog"
        aria-label={editing ? t('add.edit') : t('add.new')}
        onClick={(e) => e.stopPropagation()}
        style={{ ...(drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : {}), '--accent': accent } as CSSProperties}
      >
        <div
          className="handle-zone"
          onTouchStart={(e) => (dragStart.current = e.touches[0].clientY)}
          onTouchMove={(e) => dragStart.current !== null && setDrag(Math.max(0, e.touches[0].clientY - dragStart.current))}
          onTouchEnd={() => {
            dragStart.current = null
            if (drag > 90) onClose()
            else setDrag(0)
          }}
        >
          <span className="handle" />
          <button className="icon-btn close" aria-label={t('common.close')} onClick={onClose}>
            <IconX size={20} />
          </button>
        </div>

        {mode === 'opening' ? (
          <div className="opening-head">
            <p className="step-title">{t('add.opening', { account: accName(selected ?? undefined) })}</p>
            <p className="muted small">{t('add.openingHint')}</p>
          </div>
        ) : (
          <>
            {step === 'pick' && (
              <div className="mode-tabs" role="tablist">
                {MODES.map((m) => (
                  <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => switchMode(m)}>
                    {t(`mode.${m}` as Key)}
                  </button>
                ))}
              </div>
            )}
            <ol className="stepper" aria-label={t('add.steps')}>
              <li className={step === 'pick' ? 'current' : 'done'}>
                <button onClick={() => setStep('pick')} disabled={step === 'pick'}>
                  <span className="step-dot">{step === 'pick' ? '1' : <IconCheck size={12} stroke={3} />}</span>
                  {t('add.step1')}
                </button>
              </li>
              <li className="step-line" aria-hidden="true" />
              <li className={step === 'amount' ? 'current' : ''}>
                <button onClick={() => selected && setStep('amount')} disabled={!selected || step === 'amount'}>
                  <span className="step-dot">2</span>
                  {t('add.step2')}
                </button>
              </li>
            </ol>
          </>
        )}

        {step === 'pick' && mode !== 'opening' && (
          <div className="step-body step-pick" key={`pick-${mode}`}>
            <p className="step-title">{t(PICK_TITLE[mode])}</p>

            {picker === 'newCat' ? (
              <div className="new-cat">
                <div className="note-edit">
                  <input
                    className="input"
                    autoFocus
                    value={newCat.name}
                    placeholder={t('add.categoryName')}
                    onChange={(e) => (setNewCat((c) => ({ ...c, name: e.target.value })), setError(''))}
                    onKeyDown={(e) => e.key === 'Enter' && createCategory()}
                  />
                  <button className="primary slim" onClick={createCategory}>
                    {t('add.create')}
                  </button>
                </div>
                <div className="icon-strip">
                  {QUICK_ICONS.map((i) => (
                    <button key={i} className={newCat.icon === i ? 'on' : ''} aria-label={i} onClick={() => setNewCat((c) => ({ ...c, icon: i }))}>
                      <CategoryIcon name={i} size={20} />
                    </button>
                  ))}
                </div>
                <button className="link-btn" onClick={() => setPicker(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div className="pick-scroll">
                {(mode === 'expense' || mode === 'income') && (
                  <>
                    {suggested.length > 0 && (
                      <>
                        <p className="pick-label">{t('add.habits')}</p>
                        <div className="tiles">{suggested.map(catTile)}</div>
                        <p className="pick-label">{t('add.allCategories')}</p>
                      </>
                    )}
                    <div className="tiles">
                      {rest.map(catTile)}
                      <button className="tile" onClick={() => setPicker('newCat')}>
                        <span className="tile-icon ghost">
                          <IconPlus size={22} />
                        </span>
                        <span className="tile-name">{t('add.newCategory')}</span>
                      </button>
                    </div>
                  </>
                )}

                {mode === 'goal' && (
                  <>
                    <div className="dir-toggle" role="tablist">
                      {(['save', 'release'] as const).map((d) => (
                        <button key={d} role="tab" aria-selected={goalDir === d} className={goalDir === d ? 'on' : ''} onClick={() => setGoalDir(d)}>
                          {d === 'save' ? t('add.putAside') : t('add.takeBack')}
                        </button>
                      ))}
                    </div>
                    {activeGoals.length === 0 ? (
                      <div className="goal-empty-mini">
                        <YarnBall color="#2F6F73" progress={0.35} size={64} />
                        <p className="muted small">{t('add.noGoals')}</p>
                        <button className="primary" onClick={onNewGoal}>
                          {t('add.createGoal')}
                        </button>
                      </div>
                    ) : (
                      <div className="tiles">
                        {activeGoals.map((g) => {
                          const bal = balances.get(g.id) ?? 0
                          return tile(g.id, g.name, g.color, <YarnBall color={g.color} progress={g.target > 0 ? bal / g.target : bal > 0 ? 0.5 : 0} size={50} />, formatMoney(bal, mainCurrency))
                        })}
                        <button className="tile" onClick={onNewGoal}>
                          <span className="tile-icon ghost">
                            <IconPlus size={22} />
                          </span>
                          <span className="tile-name">{t('add.newCategory')}</span>
                        </button>
                      </div>
                    )}
                  </>
                )}

                {mode === 'transfer' && (
                  <>
                    <p className="pick-label">
                      {t('add.from')}: <button className="link-btn inline" onClick={() => setPicker(picker === 'account' ? null : 'account')}>{accName(accountId)} ▾</button>
                    </p>
                    {picker === 'account' && (
                      <div className="options">
                        {activeAccounts.map((a) => (
                          <button key={a.id} className={a.id === accountId ? 'on' : ''} onClick={() => (setAccountId(a.id), remember.set(ACCOUNT_KEY, a.id), setCurrencyCode(a.currency), setPicker(null))}>
                            {builtinName(a, 'acc')}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="tiles">
                      {activeAccounts
                        .filter((a) => a.id !== accountId)
                        .map((a) =>
                          tile(
                            a.id,
                            builtinName(a, 'acc'),
                            'var(--thread)',
                            <span className="tile-icon">
                              <IconWallet size={22} />
                            </span>,
                          ),
                        )}
                    </div>
                  </>
                )}
              </div>
            )}
            {error && <p className="error">{error}</p>}
            {!editing && onAlign && (mode === 'expense' || mode === 'income') && (
              <button className="align-link" onClick={() => onAlign(accountId)}>
                <IconScale size={16} />
                <span className="grow">
                  {t('align.fromPlus')}
                  <span className="muted small" style={{ display: 'block' }}>
                    {t('align.fromPlusHint')}
                  </span>
                </span>
                <IconChevronRight size={16} />
              </button>
            )}
          </div>
        )}

        {step === 'amount' && (
          <div className="step-body step-amount" key="amount">
            {chosen && (
              <button className="chosen" style={{ '--c': chosen.color } as CSSProperties} onClick={() => setStep('pick')}>
                <IconArrowLeft size={16} className="chosen-back" />
                <span className="chosen-icon">{chosen.icon}</span>
                <span className="chosen-label">{chosen.label}</span>
                <span className="chosen-change">{t('add.change')}</span>
              </button>
            )}

            <div className="amount-hero">
              <button className="icon-btn calc-open" aria-label={t('calc.title')} onClick={() => setCalc(true)}>
                <IconCalculator size={20} />
              </button>
              <span className={`amount-big${input ? '' : ' placeholder'}`}>{amountText}</span>
              {foreign && Number(rate) > 0 && amountMinor > 0 && (
                <span className="amount-converted">≈ {formatMoney(convertMinor(amountMinor, currency, mainCurrency, Number(rate)), mainCurrency)}</span>
              )}
              {useAll !== null && useAll > 0 && useAll !== amountMinor && (
                <button className="use-all" onClick={() => (setInput(inputFromMinor(useAll, currency.decimals)), setError(''))}>
                  {t('add.useAll', { amount: formatMoney(useAll, currency) })}
                </button>
              )}
            </div>

            <div className="ctx-row">
              <button className={`ctx${picker === 'date' ? ' on' : ''}`} onClick={() => setPicker(picker === 'date' ? null : 'date')}>
                <IconCalendar size={15} />
                {dateLabel}
                <IconChevronDown size={14} className="ctx-caret" />
              </button>
              {mode !== 'goal' && mode !== 'opening' && mode !== 'transfer' && (
                <button className={`ctx${picker === 'account' ? ' on' : ''}`} onClick={() => setPicker(picker === 'account' ? null : 'account')}>
                  <IconWallet size={15} />
                  {accName(accountId)}
                  <IconChevronDown size={14} className="ctx-caret" />
                </button>
              )}
              {mode === 'expense' && activeGoals.length > 0 && (
                <button
                  className={`ctx${picker === 'payFrom' ? ' on' : ''}${payFromGoal ? ' tinted' : ''}`}
                  style={payFromGoal ? ({ '--c': payFromGoal.color } as CSSProperties) : undefined}
                  onClick={() => setPicker(picker === 'payFrom' ? null : 'payFrom')}
                >
                  <IconPigMoney size={15} />
                  <span className="ctx-text">
                    {t('add.payFrom')}: {payFromGoal ? payFromGoal.name : t('add.payAvailable')}
                  </span>
                  <IconChevronDown size={14} className="ctx-caret" />
                </button>
              )}
              {!editing && (mode === 'expense' || mode === 'income' || (mode === 'goal' && goalDir === 'save')) && (
                <button className={`ctx${picker === 'repeat' ? ' on' : ''}${repeat !== 'none' ? ' tinted' : ''}`} onClick={() => setPicker(picker === 'repeat' ? null : 'repeat')}>
                  <IconRepeat size={15} />
                  {repeat === 'none' ? t('add.repeat') : t(`repeat.${repeat}` as Key)}
                  <IconChevronDown size={14} className="ctx-caret" />
                </button>
              )}
              {mode === 'opening' && (
                <button className={`ctx${negative ? ' on' : ''}`} onClick={() => setNegative((v) => !v)}>
                  {negative ? t('add.overdrawn') : t('add.positive')}
                </button>
              )}
              <button className={`ctx${picker === 'note' ? ' on' : ''}`} onClick={() => setPicker(picker === 'note' ? null : 'note')}>
                {note ? <IconNote size={15} /> : <IconPlus size={15} />}
                {note ? <span className="ctx-text">{note}</span> : t('add.addNote')}
              </button>
              {mode !== 'goal' && mode !== 'opening' && currencies.length > 1 && (
                <button className={`ctx${picker === 'currency' ? ' on' : ''}`} onClick={() => setPicker(picker === 'currency' ? null : 'currency')}>
                  {currency.code}
                  <IconChevronDown size={14} className="ctx-caret" />
                </button>
              )}
            </div>

            {picker === 'date' && (
              <div className="options">
                <button className={date === todayKey ? 'on' : ''} onClick={() => (setDate(todayKey), setPicker(null))}>
                  {t('common.today')}
                </button>
                <button className={date === yesterdayKey ? 'on' : ''} onClick={() => (setDate(yesterdayKey), setPicker(null))}>
                  {t('common.yesterday')}
                </button>
                <button
                  className={date !== todayKey && date !== yesterdayKey ? 'on' : ''}
                  onClick={() => {
                    const el = dateRef.current
                    try {
                      el?.showPicker()
                    } catch {
                      el?.focus()
                    }
                  }}
                >
                  {date !== todayKey && date !== yesterdayKey ? dateFmt({ weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(date)) : t('add.otherDay')}
                </button>
                <input
                  ref={dateRef}
                  type="date"
                  className="hidden-date"
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) setDate(e.target.value)
                    setPicker(null)
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                />
              </div>
            )}
            {picker === 'account' && (
              <div className="options">
                {activeAccounts.map((a) => (
                  <button key={a.id} className={a.id === accountId ? 'on' : ''} onClick={() => (setAccountId(a.id), remember.set(ACCOUNT_KEY, a.id), setCurrencyCode(a.currency), setPicker(null))}>
                    {builtinName(a, 'acc')}
                    <span className="muted small"> {a.currency}</span>
                  </button>
                ))}
              </div>
            )}
            {picker === 'currency' && (
              <div className="options">
                {currencies.map((c) => (
                  <button key={c.code} className={c.code === currency.code ? 'on' : ''} onClick={() => (setCurrencyCode(c.code), setPicker(null))}>
                    {c.code} <span className="muted small">{c.symbol}</span>
                  </button>
                ))}
              </div>
            )}
            {picker === 'payFrom' && (
              <div className="options">
                <button className={payFrom === null ? 'on' : ''} onClick={() => (setPayFrom(null), setPicker(null))}>
                  {t('add.payAvailable')}
                </button>
                {activeGoals.map((g) => (
                  <button key={g.id} className={payFrom === g.id ? 'on' : ''} onClick={() => (setPayFrom(g.id), setPicker(null))}>
                    <span className="legend-dot" style={{ background: g.color }} /> {g.name}
                    <span className="muted small"> {formatMoney(balances.get(g.id) ?? 0, mainCurrency)}</span>
                  </button>
                ))}
              </div>
            )}
            {picker === 'repeat' && (
              <div className="options">
                {REPEATS.map((r) => (
                  <button key={r} className={repeat === r ? 'on' : ''} onClick={() => (setRepeat(r), setPicker(null))}>
                    {t(`repeat.${r}` as Key)}
                  </button>
                ))}
              </div>
            )}
            {editing?.recurringId && (
              <p className="note-box" style={{ margin: 0 }}>
                <IconRepeat size={14} style={{ verticalAlign: '-2px' }} />{' '}
                {t('add.recurringInfo', { kind: editing.kind === 'income' ? t('add.kindIncome') : editing.kind === 'save' ? t('add.kindSave') : t('add.kindExpense') })}
              </p>
            )}
            {picker === 'note' && (
              <div className="note-edit">
                <input
                  className="input"
                  autoFocus
                  value={note}
                  placeholder={t('add.notePlaceholder')}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && setPicker(null)}
                />
                <button className="icon-btn" aria-label={t('common.done')} onClick={() => setPicker(null)}>
                  <IconCheck size={20} />
                </button>
              </div>
            )}

            <div className="keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
                <button key={k} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k === '.' ? decimalSep() : k}>
                  {k === '⌫' ? <IconBackspace size={22} stroke={1.6} /> : k === '.' ? decimalSep() : k}
                </button>
              ))}
            </div>

            {goalShort && (
              <p className="warn-note" role="status">
                {t('add.goalShort', { name: goalShort.goal.name, amount: formatMoney(goalShort.left, mainCurrency) })}
              </p>
            )}
            {!goalShort && overdraft !== null && outAccount && (
              <p className="warn-note" role="status">
                {t('add.overdraft', { name: builtinName(outAccount, 'acc'), amount: formatMoney(overdraft, currency) })}
              </p>
            )}
            {error && <p className="error">{error}</p>}

            <button className="save-btn" onClick={save}>
              {amountMinor > 0
                ? t('add.saveBtn', { amount: formatMoney(amountMinor * (negative ? -1 : 1), currency) })
                : t('add.enterAmount')}
            </button>

            {calc && (
              <Calculator
                initial={amountMinor > 0 ? fromMinor(amountMinor, currency.decimals) : undefined}
                onClose={() => setCalc(false)}
                onUse={(v) => {
                  setInput(String(Number(Math.abs(v).toFixed(currency.decimals))))
                  setCalc(false)
                }}
              />
            )}

            {editing && (
              <button className={`danger-link${confirmDelete ? ' armed' : ''}`} onClick={remove}>
                {confirmDelete ? t('add.deleteConfirm') : t('add.delete')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
