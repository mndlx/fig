import { IconBackspace, IconCalendar, IconCheck, IconChevronDown, IconLock, IconNote, IconPlus, IconWallet, IconX } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CategoryIcon } from './catIcons'
import { goalBalances, type AppData } from './data'
import { db, WOOL, type Kind, type Transaction } from './db'
import { YarnBall } from './Goals'
import { builtinName, dateFmt, decimalSep, t, type Key } from './i18n'
import { convertMinor, fetchRate, formatMoney, fromMinor, moneyParts, parseInput } from './money'
import { rankCategories } from './suggest'

type Mode = 'expense' | 'income' | 'goal' | 'transfer'
type Picker = 'date' | 'account' | 'currency' | 'payFrom' | 'note' | 'newCat' | null

export interface SheetPreset {
  mode: Mode
  goalDir?: 'save' | 'release'
  goalId?: string
}

interface Props {
  data: AppData
  editing: Transaction | null
  preset?: SheetPreset
  onClose: () => void
  onSaved: (tx: Transaction, previous: Transaction | null) => void
  onDeleted: (tx: Transaction) => void
  onNewGoal: () => void
}

const MODES: Mode[] = ['expense', 'income', 'goal', 'transfer']
const QUICK_ICONS = ['dots', 'cart', 'kitchen', 'coffee', 'car', 'plane', 'gym', 'pet', 'book', 'movie', 'gift', 'health', 'phone', 'bag']

function toDateInput(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Importo salvato → stringa del tastierino (sempre con "." come separatore interno). */
function inputFromMinor(minor: number, decimals: number): string {
  const text = fromMinor(minor, decimals).toFixed(decimals)
  if (decimals === 0) return text
  return text.replace(/0+$/, '').replace(/\.$/, '')
}

function modeOf(kind: Kind): Mode {
  return kind === 'save' || kind === 'release' ? 'goal' : kind
}

export function AddSheet({ data, editing, preset, onClose, onSaved, onDeleted, onNewGoal }: Props) {
  const { accounts, categories, currencies, mainCurrency, transactions, goals } = data
  const activeAccounts = accounts.filter((a) => !a.archived)
  const activeGoals = goals.filter((g) => !g.archived)
  const balances = useMemo(() => goalBalances(transactions), [transactions])
  const accName = (id: string) => {
    const a = accounts.find((x) => x.id === id)
    return a ? builtinName(a, 'acc') : '?'
  }

  const [mode, setMode] = useState<Mode>(editing ? modeOf(editing.kind) : (preset?.mode ?? 'expense'))
  const [goalDir, setGoalDir] = useState<'save' | 'release'>(editing?.kind === 'release' ? 'release' : (preset?.goalDir ?? 'save'))
  // La scelta che sblocca il tastierino: categoria, gomitolo o conto di destinazione.
  const [selected, setSelected] = useState<string | null>(() => {
    if (editing) return editing.kind === 'transfer' ? (editing.toAccountId ?? null) : editing.kind === 'save' || editing.kind === 'release' ? (editing.goalId ?? null) : (editing.categoryId ?? null)
    if (preset?.mode === 'goal') return preset.goalId ?? null
    return null
  })
  const [payFrom, setPayFrom] = useState<string | null>(
    editing ? (editing.kind === 'expense' ? (editing.goalId ?? null) : null) : preset?.mode === 'expense' ? (preset.goalId ?? null) : null,
  )
  const [accountId, setAccountId] = useState(editing?.accountId ?? activeAccounts[0]?.id ?? '')
  const [currencyCode, setCurrencyCode] = useState(editing?.currency ?? accounts.find((a) => a.id === accountId)?.currency ?? mainCurrency.code)
  const pickedCurrency = currencies.find((c) => c.code === currencyCode) ?? mainCurrency
  // I gomitoli sono sempre nella valuta principale.
  const currency = mode === 'goal' ? mainCurrency : pickedCurrency
  const [input, setInput] = useState(editing ? inputFromMinor(editing.amount, currency.decimals) : '')
  const [date, setDate] = useState(toDateInput(editing?.date ?? Date.now()))
  const [note, setNote] = useState(editing?.note ?? '')
  const [rate, setRate] = useState(editing && editing.currency !== mainCurrency.code ? String(editing.rate) : '')
  const [picker, setPicker] = useState<Picker>(null)
  const [showAll, setShowAll] = useState(false)
  const [newCat, setNewCat] = useState({ name: '', icon: 'dots' })
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [drag, setDrag] = useState(0)
  const dragStart = useRef<number | null>(null)
  const dateRef = useRef<HTMLInputElement>(null)

  const foreign = currency.code !== mainCurrency.code
  const kind: Kind = mode === 'goal' ? goalDir : mode
  const unlocked = selected !== null

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
  // Due righe da quattro: sette categorie più "Altre", oppure tutte.
  const visibleCats = showAll || ranked.length <= 8 ? ranked : ranked.slice(0, 7)

  function switchMode(m: Mode) {
    setMode(m)
    setSelected(null)
    setError('')
    setShowAll(false)
    setPicker(null)
  }

  function select(id: string) {
    setSelected(id)
    setError('')
    setPicker(null)
  }

  function press(key: string) {
    if (!unlocked) return
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
      else if (e.key === 'Enter') save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function save() {
    if (!selected) return
    const amount = parseInput(input, currency.decimals)
    if (amount <= 0) return setError(t('err.amount'))
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
      mainAmount: foreign ? convertMinor(amount, currency, mainCurrency, rateValue) : amount,
      date: when.getTime(),
      categoryId: kind === 'expense' || kind === 'income' ? selected : undefined,
      accountId,
      toAccountId: kind === 'transfer' ? selected : undefined,
      goalId: mode === 'goal' ? selected : kind === 'expense' ? (payFrom ?? undefined) : undefined,
      note: note.trim(),
      source: editing?.source ?? 'manual',
      importId: editing?.importId,
    }
    await db.transactions.put(tx)
    navigator.vibrate?.(8)
    onSaved(tx, editing)
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
    select(id)
  }

  async function remove() {
    if (!editing) return
    if (!confirmDelete) return setConfirmDelete(true)
    await db.transactions.delete(editing.id)
    onDeleted(editing)
  }

  // ——— Importo ———
  const amountMinor = parseInput(input, currency.decimals)
  const shown = moneyParts(amountMinor, currency)
  const typed = input ? input.replace('.', decimalSep()) : '0'
  const amountText = shown.symbolFirst ? `${shown.symbol}${shown.symbol.length > 1 ? ' ' : ''}${typed}` : `${typed} ${shown.symbol}`

  // ——— Pillole di contesto ———
  const todayKey = toDateInput(Date.now())
  const yesterdayKey = toDateInput(Date.now() - 86_400_000)
  const dateLabel =
    date === todayKey ? t('common.today') : date === yesterdayKey ? t('common.yesterday') : dateFmt({ day: 'numeric', month: 'short' }).format(new Date(date))
  const payFromGoal = activeGoals.find((g) => g.id === payFrom)

  const lockKey: Key = mode === 'goal' ? 'add.locked.goal' : mode === 'transfer' ? 'add.locked.account' : 'add.locked.category'
  const selectedCat = categories.find((c) => c.id === selected)
  const accent = mode === 'goal' ? (goals.find((g) => g.id === selected)?.color ?? 'var(--fig)') : (selectedCat?.color ?? 'var(--fig)')

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

        <div className="mode-tabs" role="tablist">
          {MODES.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => switchMode(m)}>
              {t(`mode.${m}` as Key)}
            </button>
          ))}
        </div>

        <div className={`amount-hero${unlocked ? '' : ' locked'}`}>
          <span className={`amount-big${input ? '' : ' placeholder'}`}>{amountText}</span>
          {foreign && Number(rate) > 0 && amountMinor > 0 && (
            <span className="amount-converted">≈ {formatMoney(convertMinor(amountMinor, currency, mainCurrency, Number(rate)), mainCurrency)}</span>
          )}
        </div>

        <div className="ctx-row">
          <button className={`ctx${picker === 'date' ? ' on' : ''}`} onClick={() => setPicker(picker === 'date' ? null : 'date')}>
            <IconCalendar size={15} />
            {dateLabel}
          </button>
          {mode !== 'goal' && (
            <button className={`ctx${picker === 'account' ? ' on' : ''}`} onClick={() => setPicker(picker === 'account' ? null : 'account')}>
              <IconWallet size={15} />
              {mode === 'transfer' ? `${t('add.from')} ${accName(accountId)}` : accName(accountId)}
            </button>
          )}
          {mode === 'expense' && activeGoals.length > 0 && (
            <button
              className={`ctx${picker === 'payFrom' ? ' on' : ''}${payFromGoal ? ' tinted' : ''}`}
              style={payFromGoal ? ({ '--c': payFromGoal.color } as CSSProperties) : undefined}
              onClick={() => setPicker(picker === 'payFrom' ? null : 'payFrom')}
            >
              {t('add.payFrom')}: {payFromGoal ? payFromGoal.name : t('add.payAvailable')}
            </button>
          )}
          <button className={`ctx${picker === 'note' ? ' on' : ''}`} onClick={() => setPicker(picker === 'note' ? null : 'note')}>
            <IconNote size={15} />
            {note ? <span className="ctx-note">{note}</span> : t('add.addNote')}
          </button>
          {mode !== 'goal' && currencies.length > 1 && (
            <button className={`ctx${picker === 'currency' ? ' on' : ''}`} onClick={() => setPicker(picker === 'currency' ? null : 'currency')}>
              {currency.code}
              <IconChevronDown size={13} />
            </button>
          )}
        </div>

        <div className="pick-area">
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
                <button
                  key={a.id}
                  className={a.id === accountId ? 'on' : ''}
                  onClick={() => {
                    setAccountId(a.id)
                    setCurrencyCode(a.currency)
                    if (mode === 'transfer' && selected === a.id) setSelected(null)
                    setPicker(null)
                  }}
                >
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

          {picker === 'newCat' && (
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
            </div>
          )}

          {picker === null && (mode === 'expense' || mode === 'income') && (
            <>
              <p className="pick-label">{showAll ? t('add.categories') : fromHabits ? t('add.habits') : t('add.categories')}</p>
              <div className={`tiles${showAll ? ' scroll' : ''}`}>
                {visibleCats.map((c) => (
                  <button
                    key={c.id}
                    className={`tile${selected === c.id ? ' on' : ''}`}
                    style={{ '--c': c.color } as CSSProperties}
                    onClick={() => select(c.id)}
                  >
                    <span className="tile-icon">
                      <CategoryIcon name={c.icon} />
                    </span>
                    <span className="tile-name">{builtinName(c, 'cat')}</span>
                  </button>
                ))}
                {!showAll && ranked.length > 8 && (
                  <button className="tile" onClick={() => setShowAll(true)}>
                    <span className="tile-icon ghost">
                      <CategoryIcon name="dots" />
                    </span>
                    <span className="tile-name">{t('common.more')}</span>
                  </button>
                )}
                {(showAll || ranked.length <= 7) && (
                  <button className="tile" onClick={() => setPicker('newCat')}>
                    <span className="tile-icon ghost">
                      <IconPlus size={22} />
                    </span>
                    <span className="tile-name">{t('add.newCategory')}</span>
                  </button>
                )}
              </div>
            </>
          )}

          {picker === null && mode === 'goal' && (
            <>
              <div className="dir-toggle" role="tablist">
                {(['save', 'release'] as const).map((d) => (
                  <button key={d} role="tab" aria-selected={goalDir === d} className={goalDir === d ? 'on' : ''} onClick={() => setGoalDir(d)}>
                    {d === 'save' ? t('add.putAside') : t('add.takeBack')}
                  </button>
                ))}
              </div>
              {activeGoals.length === 0 ? (
                <div className="goal-empty">
                  <p className="muted small">{t('add.noGoals')}</p>
                  <button className="secondary" onClick={onNewGoal}>
                    {t('add.createGoal')}
                  </button>
                </div>
              ) : (
                <div className="tiles">
                  {activeGoals.map((g) => {
                    const bal = balances.get(g.id) ?? 0
                    return (
                      <button key={g.id} className={`tile${selected === g.id ? ' on' : ''}`} style={{ '--c': g.color } as CSSProperties} onClick={() => select(g.id)}>
                        <YarnBall color={g.color} progress={g.target > 0 ? bal / g.target : bal > 0 ? 0.5 : 0} size={46} />
                        <span className="tile-name">{g.name}</span>
                        <span className="tile-sub">{formatMoney(bal, mainCurrency)}</span>
                      </button>
                    )
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

          {picker === null && mode === 'transfer' && (
            <>
              <p className="pick-label">{t('add.pickTo')}</p>
              <div className="tiles">
                {activeAccounts
                  .filter((a) => a.id !== accountId)
                  .map((a) => (
                    <button key={a.id} className={`tile${selected === a.id ? ' on' : ''}`} style={{ '--c': 'var(--thread)' } as CSSProperties} onClick={() => select(a.id)}>
                      <span className="tile-icon">
                        <IconWallet size={22} />
                      </span>
                      <span className="tile-name">{builtinName(a, 'acc')}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>

        <div className={`keypad-wrap${unlocked ? '' : ' locked'}`}>
          <div className="keypad" aria-disabled={!unlocked}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
              <button key={k} tabIndex={unlocked ? 0 : -1} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k === '.' ? decimalSep() : k}>
                {k === '⌫' ? <IconBackspace size={22} stroke={1.6} /> : k === '.' ? decimalSep() : k}
              </button>
            ))}
          </div>
          {!unlocked && (
            <p className="lock-hint">
              <IconLock size={15} />
              {t(lockKey)}
            </p>
          )}
        </div>

        {error && <p className="error">{error}</p>}

        {unlocked && (
          <button className="save-btn" onClick={save}>
            {t('add.saveBtn', { amount: formatMoney(amountMinor, currency) })}
          </button>
        )}

        {editing && (
          <button className={`danger-link${confirmDelete ? ' armed' : ''}`} onClick={remove}>
            {confirmDelete ? t('add.deleteConfirm') : t('add.delete')}
          </button>
        )}
      </div>
    </div>
  )
}
