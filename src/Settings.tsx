import {
  IconGripVertical,
  IconCategory,
  IconChevronRight,
  IconCloudUpload,
  IconCurrencyEuro,
  IconDatabaseExport,
  IconFileImport,
  IconFileSpreadsheet,
  IconLogin,
  IconLogout,
  IconTrash,
  IconRefresh,
  IconRepeat,
  IconRestore,
  IconWallet,
  IconX,
  type Icon,
} from '@tabler/icons-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ADOPT_TOAST, noteForNextPage } from './adoptionNotes'
import { exportCsv, exportJson, importJson } from './backup'
import { CATEGORY_ICONS, CategoryIcon } from './catIcons'
import { accountBalance, placeholderOnly, type AppData } from './data'
import { db, openingId, WOOL, type Account, type Category, type Frequency, type Recurring } from './db'
import { saveOpening } from './opening'
import { dropIndex, moveItem, reorder } from './reorder'
import { Reconcile } from './Reconcile'
import { deleteSeries, updateSeries } from './recurring'
import { builtinName, dateFmt, numberToInput, t, type Key, type LangSetting } from './i18n'
import { IconLeft } from './icons'
import { ImportCsv } from './ImportCsv'
import { authEnabled, currentUser, deleteAccount, isLocalOnly, localModeAllowed, setLocalOnly, signIn, signOut } from './auth'
import { adoptionPending, clearLocalData, haltSync, leaveAccount, resumeSync, syncNow, unlinkDevice, useSyncStatus } from './sync'
import { convertMinor, fetchRate, formatMoney, fromMinor, parseTyped, rebaseTransaction, soundRate } from './money'
import { rateInput } from './rate'
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
  | { type: 'profile' }

interface Props {
  data: AppData
  offline: boolean
  /** FIG senza account: dati solo su questo dispositivo. */
  local: boolean
  langSetting: LangSetting
  onLangChange: (setting: LangSetting) => void
  onBack: () => void
  /** Presente quando al primo accesso c'è da scegliere cosa fare dei dati di questo dispositivo. */
  onChooseAdoption?: () => void
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

export function Settings({ data, offline, local, langSetting, onLangChange, onBack, onChooseAdoption }: Props) {
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
    case 'profile':
      return <ProfilePage onBack={main} />
    default:
      return <SettingsMain data={data} offline={offline} local={local} langSetting={langSetting} onLangChange={onLangChange} onBack={onBack} go={setView} onChooseAdoption={onChooseAdoption} />
  }
}

function SettingsMain({
  data,
  offline,
  local,
  langSetting,
  onLangChange,
  onBack,
  go,
  onChooseAdoption,
}: {
  data: AppData
  offline: boolean
  local: boolean
  langSetting: LangSetting
  onLangChange: (s: LangSetting) => void
  onBack: () => void
  onChooseAdoption?: () => void
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
    // Archivio dell'account non ancora scaricato: un ripristino adesso verrebbe poi coperto o mescolato.
    if (placeholderOnly(data)) {
      setPendingRestore(null)
      return setMessage(t('sync.archivePending'))
    }
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

      <ProfileCard offline={offline} local={local} onOpen={() => go({ type: 'profile' })} onChooseAdoption={onChooseAdoption} />

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
      <p className="note-box">{local ? t('set.localOnlyNote') : t('set.localNote')}</p>

      {local && <DeleteLocal />}
      <p className="settings-foot">
        FIG · <a href="/privacy.html">{t('welcome.privacy')}</a>
      </p>
    </>
  )
}

/** In cima: chi sei e lo stato della sincronizzazione. */
function ProfileCard({ offline, local, onOpen, onChooseAdoption }: { offline: boolean; local: boolean; onOpen: () => void; onChooseAdoption?: () => void }) {
  const status = useSyncStatus()
  const user = currentUser()

  // Senza account: i dati sono solo qui; si può accedere per caricarli e sincronizzarli.
  if (local)
    return (
      <div className="card profile local-profile">
        <span className="grow">
          <span className="profile-name">{t('sync.localOnly')}</span>
          <span className="muted small" style={{ display: 'block' }}>
            {t('set.signInToSyncHint')}
          </span>
        </span>
        <button className="primary slim" onClick={signIn}>
          <IconLogin size={16} style={{ verticalAlign: '-3px', marginRight: 4 }} />
          {t('welcome.signIn')}
        </button>
      </div>
    )

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
  // Dati da tutte e due le parti al primo accesso: finché non si sceglie non si sincronizza niente.
  if (status.conflict) text = t('adopt.status')

  return (
    <div className="card profile">
      {/* Avatar e nome aprono il profilo: dati personali, uscita, eliminazione dell'account. */}
      <button className="profile-open" onClick={onOpen} aria-label={t('profile.title')}>
        <span className="avatar big">{(user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase()}</span>
        <span className="grow">
          <span className="profile-name">
            {user?.name ?? user?.email}
            <IconChevronRight size={16} className="menu-chevron" style={{ verticalAlign: '-2px', marginLeft: 2 }} />
          </span>
          {user?.name && user.email && <span className="muted small" style={{ display: 'block' }}>{user.email}</span>}
          <span className="profile-sync">
            <span className={`sync-dot ${offline ? 'offline' : status.state}`} />
            {text}
          </span>
        </span>
      </button>
      {!offline && (
        <button
          className={`icon-btn sync-btn${status.state === 'syncing' ? ' spinning' : ''}`}
          aria-label={status.conflict && onChooseAdoption ? t('adopt.noticeCta') : t('set.syncNow')}
          onClick={() => (status.conflict && onChooseAdoption ? onChooseAdoption() : void syncNow())}
        >
          {status.state === 'syncing' ? <IconCloudUpload size={20} /> : <IconRefresh size={20} />}
        </button>
      )}
    </div>
  )
}

/**
 * Nome e cognome da mostrare: quelli separati del servizio di identità quando ci sono;
 * altrimenti (sessioni aperte prima che venissero salvati) si divide il nome completo all'ultima parola.
 */
export function splitName(user: { name?: string; givenName?: string; familyName?: string } | null): { first: string; last: string } {
  if (user?.givenName || user?.familyName) return { first: user.givenName ?? '', last: user.familyName ?? '' }
  const parts = (user?.name ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.length > 1 ? { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] } : { first: parts[0] ?? '', last: '' }
}

/**
 * Profilo: nome, cognome ed email come li conosce il servizio di identità. Si modificano lì
 * (è l'unico che può cambiarli, email compresa); al ritorno "Aggiorna" li ricarica rifacendo
 * l'accesso, che con la sessione ancora attiva è immediato.
 */
function ProfilePage({ onBack }: { onBack: () => void }) {
  const user = currentUser()
  const online = useSyncStatus().state !== 'offline'
  const { first, last } = splitName(user)
  const field = (label: string, value?: string) => (
    <div className="list-row profile-field">
      <span className="muted small">{label}</span>
      <span className="grow profile-value">{value || t('goals.none')}</span>
    </div>
  )
  return (
    <>
      <Header title={t('profile.title')} onBack={onBack} />
      <div className="profile-head">
        <span className="avatar huge">{(user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase()}</span>
      </div>
      <div className="list">
        {field(t('profile.firstName'), first)}
        {field(t('profile.lastName'), last)}
        {field(t('profile.email'), user?.email)}
      </div>
      {authEnabled() && user?.accountUrl ? (
        <>
          <a className="primary wide profile-edit" href={user.accountUrl} target="_blank" rel="noopener">
            {t('profile.edit')}
          </a>
          <button className="secondary wide" style={{ marginTop: 8 }} disabled={!online} onClick={signIn}>
            <IconRefresh size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
            {t('profile.refresh')}
          </button>
          <p className="note-box">{t('profile.note')}</p>
        </>
      ) : (
        <p className="note-box">{t('sync.localMode')}</p>
      )}
      {authEnabled() && <SignOut />}
      {authEnabled() && <DeleteAccount />}
    </>
  )
}

/** Uscita in fondo alla pagina, con avviso se ci sono modifiche non ancora sincronizzate. */
function SignOut() {
  const status = useSyncStatus()
  const [confirm, setConfirm] = useState(false)
  const [waiting, setWaiting] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Dati usati senza account e mai arrivati nell'account: uscendo restano sul dispositivo. Lo si dice prima.
  const [keeps, setKeeps] = useState(false)

  async function doSignOut(force = false) {
    if (busy) return
    setError('')
    // Con dati mai caricati, al primo tocco si spiega cosa succede e si chiede conferma. Se nel frattempo
    // le cose sono cambiate (dati caricati da un giro in sottofondo) l'avviso si toglie e si ricomincia.
    if (!force) {
      const pending = await adoptionPending()
      if (pending !== keeps) return setKeeps(pending)
    }
    setBusy(true)
    try {
      const left = await leaveAccount(force)
      if (left.outcome === 'kept') {
        // Se si continua senza account (lo ha deciso lo scollegamento), all'arrivo lo si conferma.
        if (isLocalOnly()) noteForNextPage(ADOPT_TOAST, 'adopt.toastLeave')
        location.href = left.url
        return
      }
      if (left.outcome === 'cleared') return signOut()
      // Dispositivo già scollegato (da qui o da un'altra finestra): si riparte dall'avvio, senza cancellare niente.
      if (left.outcome === 'unlinked') return location.reload()
      if (left.outcome === 'confirm') {
        // A questo punto i dati non sono più "mai caricati": resta solo l'avviso sulle modifiche in attesa.
        setKeeps(false)
        setWaiting(left.waiting)
        setConfirm(true)
      }
      setBusy(false)
    } catch {
      setError(t('adopt.errLeave'))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="list" style={{ marginTop: 22 }}>
        <button className="list-row menu-row danger-text" disabled={busy} onClick={() => doSignOut()}>
          <span className="menu-icon danger">
            <IconLogout size={18} />
          </span>
          <span className="grow">{t('set.signOut')}</span>
        </button>
      </div>
      {error && (
        <p className="error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
      {keeps && !confirm && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px' }}>{t('set.signOutKeeps')}</p>
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={() => setKeeps(false)}>
              {t('common.cancel')}
            </button>
            <button className="primary" disabled={busy} onClick={() => doSignOut()}>
              {t('set.signOut')}
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px' }}>{t('set.signOutWarn', { n: Math.max(waiting, status.pending) })}</p>
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </button>
            <button className="primary" disabled={busy} onClick={() => doSignOut(true)}>
              {t('set.signOutAnyway')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** Riga di pericolo con conferma: usata per cancellare l'account o i dati del dispositivo. */
function DangerZone({ label, warn, confirmLabel, onConfirm }: { label: string; warn: string; confirmLabel: string; onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
    } catch {
      setError(t('set.deleteErr'))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="list" style={{ marginTop: 12 }}>
        <button className="list-row menu-row danger-text" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="menu-icon danger">
            <IconTrash size={18} />
          </span>
          <span className="grow">{label}</span>
        </button>
      </div>
      {open && (
        <div className="card danger-card" role="alertdialog" aria-label={label}>
          <p style={{ margin: '0 0 12px' }}>{warn}</p>
          <div className="form-actions">
            <button className="secondary" onClick={() => exportJson()}>
              {t('set.backup')}
            </button>
            <button className="danger" disabled={busy} onClick={confirm}>
              {confirmLabel}
            </button>
          </div>
          <button className="link-btn" style={{ marginTop: 10 }} onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </>
  )
}

/** Cancellazione dell'account: tutti i dati sul server (su ogni dispositivo) e su questo dispositivo. */
function DeleteAccount() {
  // Dati usati senza account e mai arrivati nell'account: non fanno parte di quello che si elimina, restano sul dispositivo.
  // Letto dal database in tempo reale: se nel frattempo vengono caricati, l'avviso cambia con loro.
  const keeps = useLiveQuery(() => adoptionPending(), [], false)
  return (
    <DangerZone
      label={t('set.deleteAccount')}
      warn={keeps ? `${t('set.deleteAccountWarn')} ${t('adopt.deleteAccountKeeps')}` : t('set.deleteAccountWarn')}
      confirmLabel={t('set.deleteAccountConfirm')}
      onConfirm={async () => {
        const keep = await adoptionPending()
        // Quello che si è appena letto a schermo non vale più (i dati sono stati caricati o tolti nel frattempo):
        // ci si ferma, così la conferma avviene sull'avviso aggiornato.
        if (keep !== keeps) throw new Error('changed')
        // Se poi si potrà continuare senza account lo si chiede adesso: dopo l'eliminazione non si aspetta più la rete.
        const allowed = keep && (await localModeAllowed())
        // Da qui in poi niente deve più partire verso l'account che sta per essere eliminato.
        haltSync()
        let url: string
        try {
          url = await deleteAccount()
        } catch (e) {
          resumeSync()
          throw e
        }
        if (keep) await unlinkDevice(allowed)
        else await clearLocalData()
        location.href = url
      }}
    />
  )
}

/** Senza account: si cancella tutto ciò che è salvato su questo dispositivo e si torna alla schermata iniziale. */
function DeleteLocal() {
  return (
    <DangerZone
      label={t('set.deleteLocal')}
      warn={t('set.deleteLocalWarn')}
      confirmLabel={t('set.deleteLocalConfirm')}
      onConfirm={async () => {
        await clearLocalData()
        setLocalOnly(false)
        location.href = '/'
      }}
    />
  )
}

function CategoriesPage({ data, onBack, go }: { data: AppData; onBack: () => void; go: (v: View) => void }) {
  const [kind, setKind] = useState<Category['kind']>('expense')
  const sorted = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.order - b.order)
  // Trascinamento in corso: riga presa, spostamento in pixel e passo tra una riga e l'altra.
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number; step: number } | null>(null)
  // Ordine appena rilasciato, mostrato subito in attesa che il database confermi (niente scatto all'indietro).
  const [pending, setPending] = useState<string[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const startY = useRef(0)
  useEffect(() => setPending(null), [data.categories])
  const list = pending ? [...sorted].sort((a, b) => pending.indexOf(a.id) - pending.indexOf(b.id)) : sorted
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const uses = new Map<string, number>()
  for (const tx of data.transactions) if (tx.categoryId && tx.date >= monthStart) uses.set(tx.categoryId, (uses.get(tx.categoryId) ?? 0) + 1)

  async function move(from: number, to: number) {
    if (to === from || to < 0 || to >= list.length) return
    setPending(moveItem(list, from, to).map((c) => c.id))
    await db.categories.bulkPut(reorder(list, from, to))
  }

  function onGrab(e: React.PointerEvent<HTMLButtonElement>, index: number, id: string) {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.list-row')
    if (!rows || rows.length === 0) return
    // Passo: distanza tra due righe vicine (altezza più eventuale spazio).
    const step = rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : rows[0].offsetHeight
    startY.current = e.clientY
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Alcuni browser non permettono la cattura: il trascinamento funziona comunque finché si resta sulla maniglia.
    }
    setDrag({ id, from: index, dy: 0, step })
  }

  function onDragMove(e: React.PointerEvent) {
    if (!drag) return
    // La riga non esce dalla lista.
    const min = -drag.from * drag.step
    const max = (list.length - 1 - drag.from) * drag.step
    setDrag({ ...drag, dy: Math.max(min, Math.min(max, e.clientY - startY.current)) })
  }

  function onDrop() {
    if (!drag) return
    const to = dropIndex(drag.from, drag.dy, drag.step, list.length)
    setDrag(null)
    void move(drag.from, to)
  }

  const dropAt = drag ? dropIndex(drag.from, drag.dy, drag.step, list.length) : -1
  /** Spostamento visivo di una riga mentre un'altra viene trascinata sopra o sotto di lei. */
  function shift(index: number, id: string): CSSProperties | undefined {
    if (!drag) return undefined
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)` }
    if (drag.from < dropAt && index > drag.from && index <= dropAt) return { transform: `translateY(${-drag.step}px)` }
    if (drag.from > dropAt && index >= dropAt && index < drag.from) return { transform: `translateY(${drag.step}px)` }
    return undefined
  }

  return (
    <>
      <Header title={t('set.categories')} onBack={onBack} />
      <Segmented
        label={t('set.categories')}
        value={kind}
        onChange={setKind}
        options={[
          ['expense', t('set.expenses')],
          ['income', t('set.incomes')],
        ]}
      />
      <p className="muted small" style={{ margin: '12px 2px 0' }}>
        {t('set.dragHint')}
      </p>
      <div ref={listRef} className={`list sortable${drag ? ' sorting' : ''}`} style={{ marginTop: 8 }}>
        {list.map((c, i) => {
          const name = builtinName(c, 'cat')
          const n = uses.get(c.id) ?? 0
          return (
            <div key={c.id} className={`list-row${c.archived ? ' archived' : ''}${drag?.id === c.id ? ' dragging' : ''}`} style={{ ...shift(i, c.id), '--c': c.color } as CSSProperties}>
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
              <button
                className="drag-handle"
                aria-label={t('set.dragHandle', { name })}
                onPointerDown={(e) => onGrab(e, i, c.id)}
                onPointerMove={onDragMove}
                onPointerUp={onDrop}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  // Senza trascinare: frecce su e giù sulla maniglia.
                  if (e.key === 'ArrowUp') (e.preventDefault(), void move(i, i - 1))
                  if (e.key === 'ArrowDown') (e.preventDefault(), void move(i, i + 1))
                }}
              >
                <IconGripVertical size={20} />
              </button>
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
  // Il cambio di un conto in valuta parte da quello del suo saldo iniziale: altrimenti anche solo rinominare
  // il conto lo rivaluterebbe al cambio di oggi (o, dove il cambio non si scarica, obbligherebbe a riscriverlo).
  const [rate, setRate] = useState(() => (opening && opening.currency !== mainCurrency.code ? rateInput(soundRate(opening, currency, mainCurrency)) : ''))
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reconcile, setReconcile] = useState(false)
  const foreign = code !== mainCurrency.code
  // Il saldo iniziale può cambiare mentre il modulo è aperto (impostato da "Allinea saldo" qui sotto, o arrivato
  // da un altro dispositivo): il campo lo segue, altrimenti "Salva" lo riscriverebbe col valore di prima.
  const openingAmount = opening?.amount
  // I decimali sono quelli della valuta in cui il saldo iniziale è stato salvato, non di quella appena scelta nel modulo.
  const openingDecimals = currencies.find((c) => c.code === opening?.currency)?.decimals ?? currency.decimals
  const seeded = useRef(openingAmount)
  useEffect(() => {
    if (seeded.current === openingAmount) return
    seeded.current = openingAmount
    setBalance(openingAmount !== undefined ? numberToInput(fromMinor(openingAmount, openingDecimals)) : '')
  }, [openingAmount, openingDecimals])
  const used = acc ? data.transactions.some((tx) => tx.kind !== 'opening' && (tx.accountId === acc.id || tx.toAccountId === acc.id)) : false

  const openingCurrency = opening?.currency
  useEffect(() => {
    if (!foreign) return
    // Il campo segue la valuta scelta. Se è quella del saldo iniziale vale il suo cambio (anche tornandoci dopo
    // averne provata un'altra); altrimenti si riparte da vuoto e si propone il cambio di oggi: così, se non si
    // scarica, non resta nel campo quello di un'altra valuta.
    if (opening && openingCurrency === code) {
      setRate(rateInput(soundRate(opening, currency, mainCurrency)))
      return
    }
    setRate('')
    let cancelled = false
    fetchRate(code, mainCurrency.code, new Date()).then((r) => {
      if (!cancelled && r !== null) setRate(rateInput(r))
    })
    return () => {
      cancelled = true
    }
  }, [foreign, code, mainCurrency.code, openingCurrency])

  async function save() {
    // Archivio dell'account non ancora scaricato: questi sono i conti predefiniti, non quelli dell'utente.
    if (placeholderOnly(data)) return setError(t('sync.archivePending'))
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
    await saveOpening(saved, initialBalance, initialMain, { rate: rateValue })
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
  const status = useSyncStatus()
  const { mainCurrency, currencies } = data
  const target = currencies.find((c) => c.code === code) ?? mainCurrency
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (target.code === mainCurrency.code) return
    fetchRate(mainCurrency.code, target.code, new Date()).then((r) => {
      if (r !== null) setRate(rateInput(r))
    })
  }, [target.code, mainCurrency.code])

  // I controvalori vengono ricalcolati: tasso verso la nuova valuta = tasso verso la vecchia × cambio vecchia → nuova.
  async function apply() {
    const x = rateFromInput(rate)
    if (!(x > 0)) return setError(t('mainCur.rateErr'))
    // Primo accesso non concluso: qui ci sono dati predefiniti, oppure dati del dispositivo non ancora nell'account.
    // In tutti e due i casi cambiare valuta adesso non avrebbe senso.
    if (data.archivePending) return setError(t(status.conflict ? 'adopt.notice' : placeholderOnly(data) ? 'sync.archivePending' : 'sync.uploadPending'))
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
        // La regola per ogni movimento sta in money.ts (rebaseTransaction).
        txs.map((tx) => rebaseTransaction(tx, cur.get(tx.currency) ?? mainCurrency, mainCurrency, target, x)),
      )
      const accs = await db.accounts.toArray()
      await db.accounts.bulkPut(
        accs.map((a) => ({
          ...a,
          initialMain:
            a.currency === target.code ? a.initialBalance : Math.round(fromMinor(a.initialMain, mainCurrency.decimals) * x * 10 ** target.decimals),
        })),
      )
      // Solo il campo della valuta: gli altri (es. la risposta al riquadro iniziale) restano.
      await db.settings.update('main', { mainCurrency: target.code })
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
