import {
  IconArrowsSort,
  IconCategory,
  IconChevronRight,
  IconCloudUpload,
  IconCurrencyEuro,
  IconDatabaseExport,
  IconFileImport,
  IconFileSpreadsheet,
  IconLogout,
  IconRefresh,
  IconRepeat,
  IconRestore,
  IconWallet,
  IconX,
  type Icon,
} from '@tabler/icons-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { exportCsv, exportJson, importJson } from './backup'
import { CATEGORY_ICONS, CategoryIcon } from './catIcons'
import { accountBalance, type AppData } from './data'
import { db, openingId, WOOL, type Account, type Category, type Frequency, type Recurring } from './db'
import { saveOpening } from './opening'
import { Reconcile } from './Reconcile'
import { deleteSeries, updateSeries } from './recurring'
import { builtinName, dateFmt, numberToInput, t, type Key, type LangSetting } from './i18n'
import { IconLeft } from './icons'
import { ImportCsv } from './ImportCsv'
import { authEnabled, currentUser, signOut } from './auth'
import { clearLocalData, getSyncStatus, syncNow, useSyncStatus } from './sync'
import { convertMinor, fetchRate, formatMoney, fromMinor, parseTyped } from './money'
import { readTheme, writeTheme, type Theme } from './theme'

type View =
  | { type: 'main' }
  | { type: 'categories' }
  | { type: 'category'; kind: Category['kind']; cat?: Category }
  | { type: 'accounts' }
  | { type: 'account'; acc?: Account }
  | { type: 'recurringList' }
  | { type: 'recurring'; rule: Recurring }
  | { type: 'currencies' }
  | { type: 'currency' }
  | { type: 'main-currency'; code: string }
  | { type: 'import' }

interface Props {
  data: AppData
  offline: boolean
  langSetting: LangSetting
  onLangChange: (setting: LangSetting) => void
  onBack: () => void
}

function Header({ title, onBack, action }: { title: string; onBack: () => void; action?: ReactNode }) {
  return (
    <header className="bar">
      <button className="icon-btn" aria-label={t('common.back')} onClick={onBack}>
        <IconLeft />
      </button>
      <span style={{ fontWeight: 500 }}>{title}</span>
      {action ?? <span style={{ width: 36 }} />}
    </header>
  )
}

/** Numero dal campo di testo: accetta anche il punto decimale in italiano se non ci sono migliaia. */
function rateFromInput(text: string): number {
  return Number(text.replace(',', '.'))
}

/** Riga di menu: icona, etichetta, valore riassunto e freccia. */
function MenuRow({ icon: Ico, label, value, onClick, tone }: { icon: Icon; label: string; value?: string; onClick: () => void; tone?: string }) {
  return (
    <button className={`list-row menu-row${tone ? ` ${tone}` : ''}`} onClick={onClick}>
      <span className="menu-icon">
        <Ico size={18} />
      </span>
      <span className="grow">{label}</span>
      {value && <span className="menu-value">{value}</span>}
      <IconChevronRight size={18} className="menu-chevron" />
    </button>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

export function Settings({ data, offline, langSetting, onLangChange, onBack }: Props) {
  const [view, setView] = useState<View>({ type: 'main' })
  const main = () => setView({ type: 'main' })

  switch (view.type) {
    case 'categories':
      return <CategoriesPage data={data} onBack={main} go={setView} />
    case 'category':
      return <CategoryForm data={data} kind={view.kind} cat={view.cat} onDone={() => setView({ type: 'categories' })} />
    case 'accounts':
      return <AccountsPage data={data} onBack={main} go={setView} />
    case 'account':
      return <AccountForm data={data} acc={view.acc} onDone={() => setView({ type: 'accounts' })} />
    case 'recurringList':
      return <RecurringPage data={data} onBack={main} go={setView} />
    case 'recurring':
      return <RecurringForm data={data} rule={view.rule} onDone={() => setView({ type: 'recurringList' })} />
    case 'currencies':
      return <CurrenciesPage data={data} onBack={main} go={setView} />
    case 'currency':
      return <CurrencyForm data={data} onDone={() => setView({ type: 'currencies' })} />
    case 'main-currency':
      return <MainCurrencyForm data={data} code={view.code} onDone={() => setView({ type: 'currencies' })} />
    case 'import':
      return <ImportCsv data={data} onDone={main} />
    default:
      return <SettingsMain data={data} offline={offline} langSetting={langSetting} onLangChange={onLangChange} onBack={onBack} go={setView} />
  }
}

function SettingsMain({
  data,
  offline,
  langSetting,
  onLangChange,
  onBack,
  go,
}: {
  data: AppData
  offline: boolean
  langSetting: LangSetting
  onLangChange: (s: LangSetting) => void
  onBack: () => void
  go: (v: View) => void
}) {
  const [message, setMessage] = useState('')
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const fileRef = useRef<HTMLInputElement>(null)
  const { categories, accounts, currencies, mainCurrency, recurring } = data

  const activeAccounts = accounts.filter((a) => !a.archived)
  const total = activeAccounts.reduce((sum, a) => {
    const b = accountBalance(a, data)
    return sum + (a.currency === mainCurrency.code ? b : 0)
  }, 0)
  const expenseCats = categories.filter((c) => c.kind === 'expense' && !c.archived).length
  const incomeCats = categories.filter((c) => c.kind === 'income' && !c.archived).length
  const activeRecurring = recurring.filter((r) => r.active).length

  async function restore(text: string) {
    try {
      await importJson(text)
      setMessage(t('set.restored'))
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('set.readErr'))
    }
    setPendingRestore(null)
  }

  return (
    <>
      <Header title={t('set.title')} onBack={onBack} />

      <ProfileCard offline={offline} />

      <p className="section-title">{t('set.money')}</p>
      <div className="list">
        <MenuRow icon={IconWallet} label={t('set.accounts')} value={t('set.accountsValue', { n: activeAccounts.length, total: formatMoney(total, mainCurrency) })} onClick={() => go({ type: 'accounts' })} />
        <MenuRow icon={IconCategory} label={t('set.categories')} value={t('set.categoriesValue', { e: expenseCats, i: incomeCats })} onClick={() => go({ type: 'categories' })} />
        <MenuRow icon={IconRepeat} label={t('set.recurring')} value={t('set.recurringValue', { n: activeRecurring })} onClick={() => go({ type: 'recurringList' })} />
        <MenuRow icon={IconCurrencyEuro} label={t('set.currencies')} value={`${mainCurrency.code} · ${currencies.length}`} onClick={() => go({ type: 'currencies' })} />
      </div>

      <p className="section-title">{t('set.preferences')}</p>
      <div className="list">
        <div className="list-row pref-row">
          <span className="grow">{t('set.language')}</span>
          <Segmented
            label={t('set.language')}
            value={langSetting}
            onChange={onLangChange}
            options={[
              ['auto', t('theme.auto')],
              ['en', 'EN'],
              ['it', 'IT'],
            ]}
          />
        </div>
        <div className="list-row pref-row">
          <span className="grow">{t('set.theme')}</span>
          <Segmented
            label={t('set.theme')}
            value={theme}
            onChange={(v) => {
              setTheme(v)
              writeTheme(v)
            }}
            options={[
              ['auto', t('theme.auto')],
              ['light', t('theme.light')],
              ['dark', t('theme.dark')],
            ]}
          />
        </div>
      </div>

      <p className="section-title">{t('set.data')}</p>
      <div className="list">
        <MenuRow icon={IconFileImport} label={t('set.import')} onClick={() => go({ type: 'import' })} />
        <MenuRow icon={IconFileSpreadsheet} label={t('set.exportCsv')} onClick={() => exportCsv()} />
        <MenuRow icon={IconDatabaseExport} label={t('set.backup')} onClick={() => exportJson()} />
        <MenuRow icon={IconRestore} label={t('set.restore')} onClick={() => fileRef.current?.click()} />
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) setPendingRestore(await file.text())
          }}
        />
      </div>
      {pendingRestore !== null && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px' }}>{t('set.restoreWarn')}</p>
          <div className="form-actions">
            <button className="secondary" onClick={() => setPendingRestore(null)}>
              {t('common.cancel')}
            </button>
            <button className="primary" onClick={() => restore(pendingRestore)}>
              {t('set.restoreConfirm')}
            </button>
          </div>
        </div>
      )}
      {message && <p className="note-box">{message}</p>}
      <p className="note-box">{t('set.localNote')}</p>

      {authEnabled() && !offline && <SignOut />}
      <p className="settings-foot">FIG · fig.vlabstudio.net</p>
    </>
  )
}

/** In cima: chi sei e lo stato della sincronizzazione. */
function ProfileCard({ offline }: { offline: boolean }) {
  const status = useSyncStatus()
  const user = currentUser()

  if (!authEnabled())
    return (
      <div className="card profile">
        <span className="muted small">{t('sync.localMode')}</span>
      </div>
    )

  let text: string
  if (offline || status.state === 'offline') text = t('sync.offline')
  else if (status.state === 'syncing') text = t('sync.syncing')
  else if (status.state === 'error') text = t('sync.error')
  else if (status.lastSync) text = t('sync.synced', { time: dateFmt({ hour: '2-digit', minute: '2-digit' }).format(status.lastSync) })
  else text = t('sync.never')
  if (status.pending > 0 && status.state !== 'syncing') text += ` · ${t('sync.pending', { n: status.pending })}`

  return (
    <div className="card profile">
      <span className="avatar big">{(user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="grow">
        <span className="profile-name">{user?.name ?? user?.email}</span>
        {user?.name && user.email && <span className="muted small" style={{ display: 'block' }}>{user.email}</span>}
        <span className="profile-sync">
          <span className={`sync-dot ${offline ? 'offline' : status.state}`} />
          {text}
        </span>
      </span>
      {!offline && (
        <button className={`icon-btn sync-btn${status.state === 'syncing' ? ' spinning' : ''}`} aria-label={t('set.syncNow')} onClick={() => syncNow()}>
          {status.state === 'syncing' ? <IconCloudUpload size={20} /> : <IconRefresh size={20} />}
        </button>
      )}
    </div>
  )
}

/** Uscita in fondo alla pagina, con avviso se ci sono modifiche non ancora sincronizzate. */
function SignOut() {
  const status = useSyncStatus()
  const [confirm, setConfirm] = useState(false)

  async function doSignOut(force = false) {
    if (!force) {
      await syncNow()
      if (getSyncStatus().pending > 0) return setConfirm(true)
    }
    await clearLocalData()
    signOut()
  }

  return (
    <>
      <div className="list" style={{ marginTop: 22 }}>
        <button className="list-row menu-row danger-text" onClick={() => doSignOut()}>
          <span className="menu-icon danger">
            <IconLogout size={18} />
          </span>
          <span className="grow">{t('set.signOut')}</span>
        </button>
      </div>
      {confirm && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px' }}>{t('set.signOutWarn', { n: status.pending })}</p>
          <div className="form-actions">
            <button className="secondary" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </button>
            <button className="primary" onClick={() => doSignOut(true)}>
              {t('set.signOutAnyway')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function CategoriesPage({ data, onBack, go }: { data: AppData; onBack: () => void; go: (v: View) => void }) {
  const [kind, setKind] = useState<Category['kind']>('expense')
  const [reorder, setReorder] = useState(false)
  const list = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order)
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const uses = new Map<string, number>()
  for (const tx of data.transactions) if (tx.categoryId && tx.date >= monthStart) uses.set(tx.categoryId, (uses.get(tx.categoryId) ?? 0) + 1)

  async function move(index: number, dir: -1 | 1) {
    const other = list[index + dir]
    if (!other) return
    const a = list[index]
    await db.categories.bulkPut([
      { ...a, order: other.order },
      { ...other, order: a.order },
    ])
  }

  return (
    <>
      <Header
        title={t('set.categories')}
        onBack={onBack}
        action={
          <button className={`icon-btn${reorder ? ' active' : ''}`} aria-label={t('set.reorder')} aria-pressed={reorder} onClick={() => setReorder((v) => !v)}>
            <IconArrowsSort size={20} />
          </button>
        }
      />
      <Segmented
        label={t('set.categories')}
        value={kind}
        onChange={setKind}
        options={[
          ['expense', t('set.expenses')],
          ['income', t('set.incomes')],
        ]}
      />
      <div className="list" style={{ marginTop: 14 }}>
        {list.map((c, i) => {
          const name = builtinName(c, 'cat')
          const n = uses.get(c.id) ?? 0
          return (
            <div key={c.id} className={`list-row${c.archived ? ' archived' : ''}`}>
              <span className="row-icon" style={{ '--c': c.color } as CSSProperties}>
                <CategoryIcon name={c.icon} size={18} />
              </span>
              <button className="grow" style={{ textAlign: 'left' }} onClick={() => go({ type: 'category', kind, cat: c })}>
                {name}
                {c.archived ? (
                  <span className="badge">{t('common.archived')}</span>
                ) : (
                  n > 0 && <span className="muted small" style={{ display: 'block' }}>{t('set.usesThisMonth', { n })}</span>
                )}
              </button>
              {reorder ? (
                <>
                  <button className="tiny-btn" aria-label={t('set.moveUp', { name })} onClick={() => move(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button className="tiny-btn" aria-label={t('set.moveDown', { name })} onClick={() => move(i, 1)} disabled={i === list.length - 1}>
                    ↓
                  </button>
                </>
              ) : (
                <IconChevronRight size={18} className="menu-chevron" />
              )}
            </div>
          )
        })}
      </div>
      <button className="primary wide" style={{ marginTop: 14 }} onClick={() => go({ type: 'category', kind })}>
        {t('set.newCategory')}
      </button>
    </>
  )
}

function AccountsPage({ data, onBack, go }: { data: AppData; onBack: () => void; go: (v: View) => void }) {
  const { accounts, currencies, mainCurrency } = data
  const active = accounts.filter((a) => !a.archived)
  const archived = accounts.filter((a) => a.archived)
  const total = active.reduce((s, a) => s + (a.currency === mainCurrency.code ? accountBalance(a, data) : 0), 0)
  const hasForeign = active.some((a) => a.currency !== mainCurrency.code)

  const row = (a: Account) => {
    const cur = currencies.find((c) => c.code === a.currency) ?? mainCurrency
    const b = accountBalance(a, data)
    return (
      <button key={a.id} className={`list-row menu-row${a.archived ? ' archived' : ''}`} onClick={() => go({ type: 'account', acc: a })}>
        <span className="menu-icon">
          <IconWallet size={18} />
        </span>
        <span className="grow">
          {builtinName(a, 'acc')}
          {a.archived && <span className="badge">{t('common.archived')}</span>}
          {a.currency !== mainCurrency.code && <span className="muted small" style={{ display: 'block' }}>{a.currency}</span>}
        </span>
        <span className={`legend-value${b < 0 ? ' negative' : ''}`}>{formatMoney(b, cur)}</span>
        <IconChevronRight size={18} className="menu-chevron" />
      </button>
    )
  }

  return (
    <>
      <Header title={t('set.accounts')} onBack={onBack} />
      <section className="card goals-total">
        <span className="stat-label">{t('set.total')}</span>
        <span className="goals-total-amount">{formatMoney(total, mainCurrency)}</span>
        {hasForeign && <span className="stat-extra">{t('set.totalNote', { code: mainCurrency.code })}</span>}
      </section>
      <div className="list">{active.map(row)}</div>
      {archived.length > 0 && (
        <>
          <p className="section-title">{t('common.archived')}</p>
          <div className="list">{archived.map(row)}</div>
        </>
      )}
      <button className="primary wide" style={{ marginTop: 14 }} onClick={() => go({ type: 'account' })}>
        {t('set.newAccount')}
      </button>
    </>
  )
}

function RecurringPage({ data, onBack, go }: { data: AppData; onBack: () => void; go: (v: View) => void }) {
  const { recurring, categories, currencies, mainCurrency, goals } = data
  const sorted = [...recurring].sort((a, b) => Number(b.active) - Number(a.active) || a.next - b.next)
  const monthlyOut = recurring
    .filter((r) => r.active && r.kind !== 'income')
    .reduce((s, r) => s + (r.frequency === 'month' ? r.mainAmount : r.frequency === 'week' ? Math.round((r.mainAmount * 52) / 12) : Math.round(r.mainAmount / 12)), 0)

  return (
    <>
      <Header title={t('set.recurring')} onBack={onBack} />
      {recurring.length === 0 ? (
        <p className="note-box">{t('set.recurringEmpty')}</p>
      ) : (
        <>
          <section className="card goals-total">
            <span className="stat-label">{t('set.recurringMonthly')}</span>
            <span className="goals-total-amount">{formatMoney(monthlyOut, mainCurrency)}</span>
            <span className="stat-extra">{t('set.recurringMonthlyNote')}</span>
          </section>
          <div className="list">
            {sorted.map((r) => {
              const cat = categories.find((c) => c.id === r.categoryId)
              const goal = r.kind === 'save' ? goals.find((g) => g.id === r.goalId) : undefined
              const cur = currencies.find((c) => c.code === r.currency) ?? mainCurrency
              return (
                <button key={r.id} className={`list-row${r.active ? '' : ' archived'}`} onClick={() => go({ type: 'recurring', rule: r })}>
                  <span className="row-icon" style={{ '--c': goal?.color ?? cat?.color ?? 'var(--muted)' } as CSSProperties}>
                    <CategoryIcon name={goal ? 'piggy' : cat?.icon} size={18} />
                  </span>
                  <span className="grow">
                    {r.note || goal?.name || (cat ? builtinName(cat, 'cat') : '')}
                    <span className="muted small" style={{ display: 'block' }}>
                      {t(`repeat.${r.frequency}` as Key)} ·{' '}
                      {r.active ? t('set.recurringNext', { date: dateFmt({ day: 'numeric', month: 'short' }).format(r.next) }) : t('set.recurringPaused')}
                    </span>
                  </span>
                  <span className={`legend-value${r.kind === 'income' ? ' positive' : ''}`}>
                    {formatMoney(r.kind === 'income' ? r.amount : -r.amount, cur, { sign: r.kind === 'income' })}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="note-box">{t('set.recurringHint')}</p>
        </>
      )}
    </>
  )
}

function CurrenciesPage({ data, onBack, go }: { data: AppData; onBack: () => void; go: (v: View) => void }) {
  const { currencies, mainCurrency, transactions, accounts } = data
  const [armed, setArmed] = useState<string | null>(null)
  const used = new Set([...transactions.map((tx) => tx.currency), ...accounts.map((a) => a.currency), mainCurrency.code])

  async function remove(code: string) {
    if (armed !== code) return setArmed(code)
    await db.currencies.delete(code)
    setArmed(null)
  }

  return (
    <>
      <Header title={t('set.currencies')} onBack={onBack} />
      <div className="list">
        <label className="list-row">
          <span className="grow">{t('set.mainCurrency')}</span>
          <select className="currency-pick" value={mainCurrency.code} onChange={(e) => go({ type: 'main-currency', code: e.target.value })} aria-label={t('set.mainCurrency')}>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="section-title">{t('set.currencyList')}</p>
      <div className="list">
        {currencies.map((c) => (
          <div key={c.code} className="list-row">
            <span className="currency-symbol">{c.symbol}</span>
            <span className="grow">
              {c.code}
              <span className="muted small" style={{ display: 'block' }}>
                {c.code === mainCurrency.code ? t('set.currencyMain') : used.has(c.code) ? t('set.currencyUsed') : t('curForm.decimalsValue', { n: c.decimals })}
              </span>
            </span>
            {!used.has(c.code) && (
              <button className={`tiny-btn${armed === c.code ? ' armed' : ''}`} aria-label={t('curForm.remove', { code: c.code })} onClick={() => remove(c.code)}>
                {armed === c.code ? t('curForm.removeConfirm') : <IconX size={16} />}
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="primary wide" style={{ marginTop: 14 }} onClick={() => go({ type: 'currency' })}>
        {t('set.addCurrency')}
      </button>
      <p className="note-box">{t('curForm.note')}</p>
    </>
  )
}

function RecurringForm({ data, rule, onDone }: { data: AppData; rule: Recurring; onDone: () => void }) {
  const currency = data.currencies.find((c) => c.code === rule.currency) ?? data.mainCurrency
  const cat = data.categories.find((c) => c.id === rule.categoryId)
  const [amount, setAmount] = useState(numberToInput(fromMinor(rule.amount, currency.decimals)))
  const [frequency, setFrequency] = useState<Frequency>(rule.frequency)
  const [note, setNote] = useState(rule.note)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const kindLabel = rule.kind === 'income' ? t('add.kindIncome') : rule.kind === 'save' ? t('add.kindSave') : t('add.kindExpense')

  async function save(active = rule.active) {
    const value = parseTyped(amount, currency.decimals)
    if (value <= 0) return setError(t('err.amount'))
    const ratio = rule.amount ? rule.mainAmount / rule.amount : 1
    await updateSeries({ ...rule, amount: value, mainAmount: Math.round(value * ratio), frequency, note: note.trim(), active })
    onDone()
  }

  async function remove() {
    if (!confirmDelete) return setConfirmDelete(true)
    await deleteSeries(rule)
    onDone()
  }

  return (
    <>
      <Header title={t('rec.title', { kind: kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1) })} onBack={onDone} />
      <div className="goal-preview">
        <span className="tile-icon big" style={{ '--c': cat?.color ?? 'var(--muted)' } as CSSProperties}>
          <CategoryIcon name={cat?.icon} size={32} />
        </span>
      </div>
      <div className="card form">
        <div className="form-row">
          <label className="field">
            {t('rec.amount')} ({currency.symbol})
            <input inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value), setError(''))} />
          </label>
          <label className="field">
            {t('rec.frequency')}
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(['week', 'month', 'year'] as const).map((f) => (
                <option key={f} value={f}>
                  {t(`repeat.${f}` as Key)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          {t('common.note')}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={cat ? builtinName(cat, 'cat') : ''} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="secondary" onClick={() => save(!rule.active)}>
            {rule.active ? t('rec.stop') : t('rec.resume')}
          </button>
          <button className="primary" onClick={() => save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
      <p className="note-box">
        {t('rec.note')}{' '}
        <button className={`danger-link${confirmDelete ? ' armed' : ''}`} style={{ padding: 0 }} onClick={remove}>
          {confirmDelete ? t('rec.deleteConfirm') : t('rec.delete')}
        </button>
      </p>
    </>
  )
}

function CategoryForm({ data, kind, cat, onDone }: { data: AppData; kind: Category['kind']; cat?: Category; onDone: () => void }) {
  const original = cat ? builtinName(cat, 'cat') : ''
  const [name, setName] = useState(original)
  const [icon, setIcon] = useState(cat?.icon ?? 'dots')
  const [color, setColor] = useState(cat?.color ?? WOOL[data.categories.length % WOOL.length])
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const used = cat ? data.transactions.some((tx) => tx.categoryId === cat.id) : false

  async function save() {
    if (!name.trim()) return setError(t('err.name'))
    const order = cat?.order ?? Math.max(0, ...data.categories.map((c) => c.order)) + 1
    // Se il nome di una categoria predefinita non cambia, resta tradotto in ogni lingua.
    const keepBuiltin = cat?.key && !cat.name && name.trim() === original
    await db.categories.put({
      id: cat?.id ?? crypto.randomUUID(),
      name: keepBuiltin ? '' : name.trim(),
      key: cat?.key,
      icon,
      kind,
      color,
      order,
      archived: cat?.archived ?? false,
    })
    onDone()
  }

  async function toggleArchive() {
    if (!cat) return
    await db.categories.update(cat.id, { archived: !cat.archived })
    onDone()
  }

  async function remove() {
    if (!cat) return
    if (!confirmDelete) return setConfirmDelete(true)
    await db.categories.delete(cat.id)
    await db.rules.filter((r) => r.categoryId === cat.id).delete()
    onDone()
  }

  return (
    <>
      <Header title={cat ? t('catForm.edit') : kind === 'expense' ? t('catForm.newExpense') : t('catForm.newIncome')} onBack={onDone} />
      <div className="goal-preview">
        <span className="tile-icon big" style={{ '--c': color } as CSSProperties}>
          <CategoryIcon name={icon} size={32} />
        </span>
      </div>
      <div className="card form">
        <label className="field">
          {t('common.name')}
          <input value={name} autoFocus={!cat} onChange={(e) => (setName(e.target.value), setError(''))} placeholder={t('catForm.placeholder')} />
        </label>
        <div className="field">
          {t('common.icon')}
          <div className="icon-grid">
            {Object.keys(CATEGORY_ICONS).map((i) => (
              <button key={i} className={i === icon ? 'on' : ''} aria-label={i} onClick={() => setIcon(i)}>
                <CategoryIcon name={i} size={20} />
              </button>
            ))}
          </div>
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
          {cat && (
            <button className="secondary" onClick={toggleArchive}>
              {cat.archived ? t('common.restore') : t('common.archive')}
            </button>
          )}
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
      {cat && (
        <p className="note-box">
          {used ? t('catForm.used') : t('catForm.unused')}
          {!used && (
            <>
              {' '}
              <button className={`danger-link${confirmDelete ? ' armed' : ''}`} style={{ padding: 0 }} onClick={remove}>
                {confirmDelete ? t('catForm.deleteConfirm') : t('catForm.delete')}
              </button>
            </>
          )}
        </p>
      )}
    </>
  )
}

function AccountForm({ data, acc, onDone }: { data: AppData; acc?: Account; onDone: () => void }) {
  const { currencies, mainCurrency } = data
  const original = acc ? builtinName(acc, 'acc') : ''
  const [name, setName] = useState(original)
  const [code, setCode] = useState(acc?.currency ?? mainCurrency.code)
  const currency = currencies.find((c) => c.code === code) ?? mainCurrency
  // Il saldo iniziale è il nodo "opening" del conto sul filo.
  const opening = acc ? data.transactions.find((tx) => tx.id === openingId(acc.id)) : undefined
  const [balance, setBalance] = useState(opening ? numberToInput(fromMinor(opening.amount, currency.decimals)) : '')
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reconcile, setReconcile] = useState(false)
  const foreign = code !== mainCurrency.code
  const used = acc ? data.transactions.some((tx) => tx.kind !== 'opening' && (tx.accountId === acc.id || tx.toAccountId === acc.id)) : false

  useEffect(() => {
    if (!foreign) return
    let cancelled = false
    fetchRate(code, mainCurrency.code, new Date()).then((r) => {
      if (!cancelled && r !== null) setRate(numberToInput(Number(r.toFixed(6))))
    })
    return () => {
      cancelled = true
    }
  }, [foreign, code, mainCurrency.code])

  async function save() {
    if (!name.trim()) return setError(t('err.name'))
    const initialBalance = parseTyped(balance, currency.decimals)
    const rateValue = foreign ? rateFromInput(rate) : 1
    if (foreign && initialBalance !== 0 && !(rateValue > 0)) return setError(t('err.rate', { from: code, to: mainCurrency.code }))
    const initialMain = foreign ? Math.sign(initialBalance) * convertMinor(Math.abs(initialBalance), currency, mainCurrency, rateValue || 0) : initialBalance
    const order = acc?.order ?? Math.max(0, ...data.accounts.map((a) => a.order ?? 0)) + 1
    const keepBuiltin = acc?.key && !acc.name && name.trim() === original
    const saved: Account = {
      id: acc?.id ?? crypto.randomUUID(),
      name: keepBuiltin ? '' : name.trim(),
      key: acc?.key,
      currency: code,
      initialBalance: 0,
      initialMain: 0,
      order,
      archived: acc?.archived ?? false,
    }
    await db.accounts.put(saved)
    await saveOpening(saved, initialBalance, initialMain)
    onDone()
  }

  async function toggleArchive() {
    if (!acc) return
    await db.accounts.update(acc.id, { archived: !acc.archived })
    onDone()
  }

  async function remove() {
    if (!acc) return
    if (!confirmDelete) return setConfirmDelete(true)
    await db.transactions.delete(openingId(acc.id))
    await db.accounts.delete(acc.id)
    onDone()
  }

  return (
    <>
      <Header title={acc ? t('accForm.edit') : t('accForm.new')} onBack={onDone} />
      {acc && !acc.archived && (
        <section className="card rec-card">
          <span className="grow">
            <span className="stat-label">{t('align.inFig')}</span>
            <span className={`rec-value${accountBalance(acc, data) < 0 ? ' negative' : ''}`}>{formatMoney(accountBalance(acc, data), currency)}</span>
          </span>
          <button className="secondary slim" onClick={() => setReconcile(true)}>
            {t('align.cta')}
          </button>
        </section>
      )}
      {reconcile && acc && <Reconcile data={data} account={acc} onClose={() => setReconcile(false)} />}
      <div className="card form">
        <label className="field">
          {t('common.name')}
          <input value={name} autoFocus={!acc} onChange={(e) => (setName(e.target.value), setError(''))} placeholder={t('accForm.placeholder')} />
        </label>
        <div className="form-row">
          <label className="field">
            {t('common.currency')}
            <select value={code} onChange={(e) => setCode(e.target.value)} disabled={used}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('accForm.initial')}
            <input inputMode="decimal" value={balance} onChange={(e) => (setBalance(e.target.value), setError(''))} placeholder="0" />
          </label>
        </div>
        {foreign && (
          <label className="field">
            {t('accForm.rate', { from: code, to: mainCurrency.code })}
            <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {acc && (
            <button className="secondary" onClick={toggleArchive}>
              {acc.archived ? t('common.restore') : t('common.archive')}
            </button>
          )}
          <button className="primary" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
      {acc && (
        <p className="note-box">
          {used ? t('accForm.used') : t('accForm.unused')}
          {!used && (
            <>
              {' '}
              <button className={`danger-link${confirmDelete ? ' armed' : ''}`} style={{ padding: 0 }} onClick={remove}>
                {confirmDelete ? t('accForm.deleteConfirm') : t('accForm.delete')}
              </button>
            </>
          )}
        </p>
      )}
    </>
  )
}

function CurrencyForm({ data, onDone }: { data: AppData; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [symbol, setSymbol] = useState('')
  const [decimals, setDecimals] = useState(2)
  const [error, setError] = useState('')

  async function save() {
    const c = code.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(c)) return setError(t('curForm.codeErr'))
    if (data.currencies.some((x) => x.code === c)) return setError(t('curForm.exists'))
    await db.currencies.add({ code: c, symbol: symbol.trim() || c, decimals })
    onDone()
  }

  return (
    <>
      <Header title={t('curForm.title')} onBack={onDone} />
      <div className="card form">
        <div className="form-row">
          <label className="field">
            {t('curForm.code')}
            <input value={code} autoFocus maxLength={3} onChange={(e) => (setCode(e.target.value.toUpperCase()), setError(''))} placeholder="JPY" />
          </label>
          <label className="field">
            {t('curForm.symbol')}
            <input value={symbol} maxLength={4} onChange={(e) => setSymbol(e.target.value)} placeholder="¥" />
          </label>
          <label className="field">
            {t('curForm.decimals')}
            <select value={decimals} onChange={(e) => setDecimals(Number(e.target.value))}>
              <option value={0}>0</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="primary" onClick={save}>
            {t('common.add')}
          </button>
        </div>
      </div>
      <p className="note-box">{t('curForm.note')}</p>
    </>
  )
}

function MainCurrencyForm({ data, code, onDone }: { data: AppData; code: string; onDone: () => void }) {
  const { mainCurrency, currencies } = data
  const target = currencies.find((c) => c.code === code) ?? mainCurrency
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (target.code === mainCurrency.code) return
    fetchRate(mainCurrency.code, target.code, new Date()).then((r) => {
      if (r !== null) setRate(numberToInput(Number(r.toFixed(6))))
    })
  }, [target.code, mainCurrency.code])

  // I controvalori vengono ricalcolati: tasso verso la nuova valuta = tasso verso la vecchia × cambio vecchia → nuova.
  async function apply() {
    const x = rateFromInput(rate)
    if (!(x > 0)) return setError(t('mainCur.rateErr'))
    setBusy(true)
    const cur = new Map(currencies.map((c) => [c.code, c]))
    const toTarget = (minor: number) => Math.round(fromMinor(minor, mainCurrency.decimals) * x * 10 ** target.decimals)
    await db.transaction('rw', [db.transactions, db.accounts, db.settings, db.goals, db.recurring], async () => {
      // Obiettivi dei gomitoli e ricorrenti sono espressi nella valuta principale: vanno convertiti anche loro.
      const goals = await db.goals.toArray()
      await db.goals.bulkPut(goals.map((g) => ({ ...g, target: toTarget(g.target) })))
      const rules = await db.recurring.toArray()
      await db.recurring.bulkPut(
        rules.map((r) => {
          if (r.currency === target.code) return { ...r, rate: 1, mainAmount: r.amount }
          // Gli accantonamenti sono nella valuta principale: diventano nella nuova.
          if (r.kind === 'save') return { ...r, currency: target.code, rate: 1, amount: toTarget(r.amount), mainAmount: toTarget(r.amount) }
          const from = cur.get(r.currency) ?? mainCurrency
          const newRate = r.rate * x
          return { ...r, rate: newRate, mainAmount: convertMinor(r.amount, from, target, newRate) }
        }),
      )
      const txs = await db.transactions.toArray()
      await db.transactions.bulkPut(
        txs.map((tx) => {
          const from = cur.get(tx.currency) ?? mainCurrency
          const newRate = tx.currency === target.code ? 1 : tx.rate * x
          return { ...tx, rate: newRate, mainAmount: tx.currency === target.code ? tx.amount : convertMinor(tx.amount, from, target, newRate) }
        }),
      )
      const accs = await db.accounts.toArray()
      await db.accounts.bulkPut(
        accs.map((a) => ({
          ...a,
          initialMain:
            a.currency === target.code ? a.initialBalance : Math.round(fromMinor(a.initialMain, mainCurrency.decimals) * x * 10 ** target.decimals),
        })),
      )
      await db.settings.put({ id: 'main', mainCurrency: target.code })
    })
    onDone()
  }

  return (
    <>
      <Header title={t('mainCur.title')} onBack={onDone} />
      <div className="card form">
        <p style={{ margin: 0 }}>{t('mainCur.body', { from: mainCurrency.code, to: target.code })}</p>
        <label className="field">
          {t('mainCur.rate', { from: mainCurrency.code, to: target.code })}
          <input inputMode="decimal" value={rate} onChange={(e) => (setRate(e.target.value), setError(''))} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="secondary" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={apply} disabled={busy}>
            {t('mainCur.apply')}
          </button>
        </div>
      </div>
    </>
  )
}
