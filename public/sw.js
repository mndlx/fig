// Service worker di FIG: tiene in cache l'app così si apre anche offline.
// I dati non passano di qui: stanno in IndexedDB.
const CACHE = 'fig-v5'

self.addEventListener('install', (event) => {
  // Oltre alla pagina, i file che la pagina carica (script e stile, coi nomi di questa versione): così l'app si apre
  // offline già dal lancio successivo, anche al primo avvio e subito dopo un aggiornamento.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const page = await fetch('/', { cache: 'no-store' })
      if (!page.ok || page.redirected) throw new Error('pagina non disponibile')
      await cache.put('/', page.clone())
      const assets = [...(await page.text()).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
      await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)))
    })(),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Cambio di versione della cache: i caratteri già scaricati passano in quella nuova (hanno l'hash nel nome, non
  // cambiano, e l'installazione qui sopra non li prende: li cita il foglio di stile, non la pagina). Il resto si butta.
  event.waitUntil(
    (async () => {
      const fresh = await caches.open(CACHE)
      for (const key of await caches.keys()) {
        if (key === CACHE) continue
        const old = await caches.open(key)
        for (const request of await old.keys()) {
          if (!/^\/assets\/.+\.woff2$/.test(new URL(request.url).pathname) || (await fresh.match(request))) continue
          const response = await old.match(request)
          if (response) await fresh.put(request, response)
        }
        await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  // Solo richieste GET della app stessa: i tassi di cambio vanno sempre in rete.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // API e login non passano mai dalla cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return

  // Pagine pubbliche separate (privacy, eliminazione account): sempre dalla rete, mai al posto dell'app.
  if (url.pathname.endsWith('.html')) return
  // Manifest, icone e immagini di avvio non hanno un hash nel nome: dalla cache resterebbero quelli vecchi per sempre,
  // e il telefono non vedrebbe mai un'icona nuova. Li chiede il sistema quando installa o aggiorna l'app, non servono offline.
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.svg' || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/splash/')) return

  if (request.mode === 'navigate') {
    // Pagina: prima la rete (per gli aggiornamenti), poi la copia in cache.
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Si salva solo la pagina vera, non i redirect del login.
          if (res.ok && res.type === 'basic' && !res.redirected) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put('/', copy))
          }
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  // Solo i file con l'hash nel nome (/assets/) si servono dalla cache: gli altri (per esempio lo stile delle pagine
  // pubbliche) cambiano senza cambiare nome, e dalla cache resterebbero vecchi per sempre.
  if (!url.pathname.startsWith('/assets/')) return

  // File statici con hash nel nome: prima la cache.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return res
        }),
    ),
  )
})
