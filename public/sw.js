// Service worker di FIG: tiene in cache l'app così si apre anche offline.
// I dati non passano di qui: stanno in IndexedDB.
const CACHE = 'fig-v4'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/favicon.svg'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
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
