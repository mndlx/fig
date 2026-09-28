import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initAuth, signIn } from './auth'
import { db } from './db'
import { t } from './i18n'
import { IconFig } from './icons'
import { startSync } from './sync'
import './styles.css'

// In sviluppo niente service worker, altrimenti la cache nasconde le modifiche.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}

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

async function boot() {
  root.render(<Gate kind="loading" />)
  const auth = await initAuth()
  let offline = false
  if (auth.status === 'signed-in') {
    await startSync(auth.user)
  } else {
    // Senza login si può usare l'app solo se su questo dispositivo c'è già il proprio archivio.
    const owner = await db.syncMeta.get('owner')
    if (auth.status !== 'offline' || !owner) return root.render(<Gate kind={auth.status} />)
    offline = true
  }
  root.render(
    <StrictMode>
      <App offline={offline} />
    </StrictMode>,
  )
}

void boot()
