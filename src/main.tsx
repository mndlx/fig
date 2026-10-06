import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AdoptionChoice } from './AdoptionChoice'
import App from './App'
import { initAuth, isLocalOnly, setLocalOnly, signIn } from './auth'
import { db } from './db'
import { getLang, t } from './i18n'
import { IconFig } from './icons'
import { materializeRecurring } from './recurring'
import { getSyncStatus, startSync, stopSyncQueue, useSyncStatus } from './sync'
import { applyTheme, readTheme } from './theme'
import '@fontsource-variable/fraunces/opsz.css'
import '@fontsource-variable/inter'
import './styles.css'

// In sviluppo niente service worker, altrimenti la cache nasconde le modifiche.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}

// Tema scelto dall'utente, prima del primo disegno.
applyTheme(readTheme())
// Lingua della pagina già dalle prime schermate (attesa, benvenuto), non solo quando parte l'app.
document.documentElement.lang = getLang()

const root = createRoot(document.getElementById('root')!)

/** Quanto si aspetta il primo scaricamento dell'archivio prima di aprire comunque l'app (che avvisa e riprova da sola). */
const FIRST_SYNC_WAIT = 10_000

function Wordmark() {
  return (
    <h1 className="wordmark big">
      <IconFig />
      fig
    </h1>
  )
}

function Gate({ kind }: { kind: 'loading' | 'loading-data' | 'checking' | 'offline' | 'error' | 'server-down' }) {
  if (kind === 'loading' || kind === 'loading-data' || kind === 'checking') {
    return (
      <main className="gate">
        <Wordmark />
        {/* L'avvio normale dura un attimo: il testo si vede solo quando c'è da scaricare i dati dell'account. */}
        <p className={kind === 'loading' ? 'sr-only' : 'muted'} role="status">
          {t(kind === 'loading-data' ? 'auth.loadingData' : kind === 'checking' ? 'adopt.checking' : 'auth.loading')}
        </p>
      </main>
    )
  }
  const message = kind === 'offline' ? t('auth.offline') : kind === 'server-down' ? t('auth.serverDown') : t('auth.error')
  return (
    <main className="gate">
      <Wordmark />
      <p className="muted" role="alert">
        {message}
      </p>
      {kind === 'server-down' && import.meta.env.DEV && <p className="muted small">Dev: start the API with “npm run dev” in the fig folder.</p>}
      <button className="primary" onClick={() => (kind === 'error' ? signIn() : location.reload())}>
        {t('auth.retry')}
      </button>
    </main>
  )
}

/**
 * Primo avvio senza sessione: due righe su cos'è FIG prima della pagina di accesso.
 * Se il server lo permette si può anche partire senza account, coi dati solo sul dispositivo.
 */
function Welcome({ localMode }: { localMode: boolean }) {
  return (
    <main className="gate welcome">
      <Wordmark />
      <p className="welcome-tagline">{t('welcome.tagline')}</p>
      <div className="welcome-choices">
        {localMode ? (
          <>
            <button
              className="primary wide"
              onClick={() => {
                setLocalOnly(true)
                void boot()
              }}
            >
              {t('welcome.local')}
            </button>
            <p className="muted small">{t('welcome.localHint')}</p>
            <button className="secondary wide" onClick={signIn}>
              {t('welcome.signIn')}
            </button>
            <p className="muted small">{t('welcome.signInHint')}</p>
          </>
        ) : (
          <>
            <button className="primary wide" onClick={signIn}>
              {t('welcome.signIn')}
            </button>
            <p className="muted small">{t('welcome.accountHint')}</p>
          </>
        )}
      </div>
      <a className="welcome-privacy" href="/privacy.html">
        {t('welcome.privacy')}
      </a>
    </main>
  )
}

/**
 * L'app, oppure la scelta del primo accesso quando sia il dispositivo sia l'account hanno già dei dati.
 * La scelta si apre da sola solo se è già nota al primo disegno (è la continuazione dell'accesso); se arriva
 * più tardi l'app resta a schermo con un avviso, così non sparisce quello che si stava scrivendo.
 */
function Root({ offline, local }: { offline: boolean; local: boolean }) {
  const status = useSyncStatus()
  const [choosing, setChoosing] = useState(() => getSyncStatus().conflict)
  if (choosing) return <AdoptionChoice onClose={() => setChoosing(false)} />
  return <App offline={offline} local={local} onChooseAdoption={status.conflict ? () => setChoosing(true) : undefined} />
}

function renderApp(offline: boolean, local: boolean) {
  root.render(
    <StrictMode>
      <Root offline={offline} local={local} />
    </StrictMode>,
  )
}

// Un'altra finestra ha fatto l'accesso, o è tornata all'uso senza account: questa riparte dall'avvio,
// altrimenti continuerebbe a scrivere con le regole di prima (per esempio senza mettere in coda le modifiche).
window.addEventListener('storage', (event) => {
  if (event.key === 'fig-local') location.reload()
})

/**
 * Sessione partita senza rete, o col server irraggiungibile: appena torna raggiungibile si riprende
 * la sincronizzazione senza ricaricare la pagina (prima restava ferma fino al riavvio dell'app).
 */
function resumeWhenReachable() {
  let busy = false
  let timer = 0
  const stop = () => {
    window.removeEventListener('online', check)
    document.removeEventListener('visibilitychange', check)
    window.clearInterval(timer)
  }
  async function check() {
    if (busy || !navigator.onLine || document.visibilityState !== 'visible') return
    busy = true
    try {
      const auth = await initAuth()
      if (auth.status === 'signed-in') {
        stop()
        if (await startSync(auth.user)) renderApp(false, false)
      } else if (auth.status === 'signed-out') {
        // Sessione scaduta nel frattempo: si rientra. Le modifiche restano sul dispositivo e partono dopo l'accesso.
        stop()
        signIn()
      }
    } finally {
      busy = false
    }
  }
  window.addEventListener('online', check)
  document.addEventListener('visibilitychange', check)
  timer = window.setInterval(check, 30_000)
}

async function boot() {
  root.render(<Gate kind="loading" />)
  const auth = await initAuth()
  const owner = await db.syncMeta.get('owner')
  let offline = false
  let local = false
  if (auth.status === 'signed-in') {
    // Accesso fatto: il dispositivo viene legato all'account e il primo giro decide come i dati che ci sono qui
    // incontrano quelli dell'account (si caricano, o si chiede cosa farne se anche l'account ne ha).
    setLocalOnly(false)
    const sync = await startSync(auth.user)
    // Sul dispositivo c'erano i dati di un altro utente: sono stati cancellati e la pagina si ricarica.
    if (!sync) return
    if (sync.adopting) {
      // Primo accesso su questo dispositivo: l'app si apre sui dati dell'utente, non su quelli predefiniti.
      // Se qui ci sono già dati suoi (usato senza account) non li si sta sostituendo: si controlla cosa c'è nell'account.
      const hasData = (await db.transactions.count()) + (await db.goals.count()) + (await db.recurring.count()) > 0
      root.render(<Gate kind={hasData ? 'checking' : 'loading-data'} />)
      await Promise.race([sync.first, new Promise((resolve) => window.setTimeout(resolve, FIRST_SYNC_WAIT))])
    }
  } else if (owner) {
    // Dispositivo già collegato a un account: sessione scaduta → si rientra.
    if (auth.status === 'signed-out') return signIn()
    // Senza rete, o col server che non risponde, si lavora sui dati del dispositivo e si riprende appena possibile.
    offline = true
    resumeWhenReachable()
  } else if (isLocalOnly() && (auth.status !== 'signed-out' || auth.localMode)) {
    // Senza account: niente coda di sincronizzazione, i dati restano solo nel browser.
    local = true
    await stopSyncQueue()
  } else if (auth.status === 'signed-out') {
    // Mai entrati da questo dispositivo: prima due righe di benvenuto, poi l'accesso
    // (i dati locali rimasti da prima restano; dopo l'accesso si decide come uniscono a quelli dell'account).
    return root.render(<Welcome localMode={auth.localMode} />)
  } else {
    return root.render(<Gate kind={auth.status} />)
  }
  // Scadenze delle serie ricorrenti fino a fine mese. Con l'accesso attivo le genera la sincronizzazione
  // dopo aver scaricato le novità (così un dispositivo rimasto indietro non sovrascrive modifiche fatte altrove);
  // senza rete e senza account si generano subito dai dati locali. Col server irraggiungibile ma la rete
  // presente si aspetta: sta per tornare, e la ripresa le genera dopo aver scaricato.
  if (local || auth.status === 'offline') void materializeRecurring()
  renderApp(offline, local)
}

void boot()
