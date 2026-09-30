import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initAuth, isLocalOnly, setLocalOnly, signIn } from './auth'
import { db } from './db'
import { t } from './i18n'
import { IconFig } from './icons'
import { materializeRecurring } from './recurring'
import { startSync } from './sync'
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

const root = createRoot(document.getElementById('root')!)

function Gate({ kind }: { kind: 'loading' | 'offline' | 'error' | 'server-down' }) {
  const message = kind === 'offline' ? t('auth.offline') : kind === 'server-down' ? t('auth.serverDown') : t('auth.error')
  return (
    <div className="gate">
      <span className="wordmark big">
        <IconFig />
        fig
      </span>
      {kind !== 'loading' && (
        <>
          <p className="muted">{message}</p>
          <button className="primary" onClick={() => (kind === 'error' ? signIn() : location.reload())}>
            {t('auth.retry')}
          </button>
        </>
      )}
    </div>
  )
}

/** Primo avvio senza sessione: si sceglie se usare FIG solo su questo dispositivo o accedere. */
function Welcome() {
  return (
    <div className="gate welcome">
      <span className="wordmark big">
        <IconFig />
        fig
      </span>
      <p className="welcome-tagline">{t('welcome.tagline')}</p>
      <div className="welcome-choices">
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
      </div>
      <a className="welcome-privacy" href="/privacy.html">
        {t('welcome.privacy')}
      </a>
    </div>
  )
}

async function boot() {
  root.render(<Gate kind="loading" />)
  const auth = await initAuth()
  const owner = await db.syncMeta.get('owner')
  let offline = false
  let local = false
  if (auth.status === 'signed-in') {
    // Accesso fatto: i dati usati senza account vengono caricati sul proprio archivio (vedi startSync).
    setLocalOnly(false)
    await startSync(auth.user)
  } else if (owner) {
    // Dispositivo già collegato a un account: sessione scaduta → si rientra; senza rete si usano i dati locali.
    if (auth.status === 'signed-out') return signIn()
    if (auth.status !== 'offline') return root.render(<Gate kind={auth.status} />)
    offline = true
  } else if (isLocalOnly()) {
    local = true
  } else if (auth.status === 'signed-out') {
    return root.render(<Welcome />)
  } else {
    return root.render(<Gate kind={auth.status} />)
  }
  // Scadenze delle serie ricorrenti fino a fine mese. Con l'accesso attivo le genera la sincronizzazione
  // dopo aver scaricato le novità (così un dispositivo rimasto indietro non sovrascrive modifiche fatte altrove);
  // offline e senza account si generano subito dai dati locali.
  if (offline || local) void materializeRecurring()
  root.render(
    <StrictMode>
      <App offline={offline} local={local} />
    </StrictMode>,
  )
}

void boot()
