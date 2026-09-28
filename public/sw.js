// Service worker di FIG: tiene in cache l'app così si apre anche offline.
// I dati non passano di qui: stanno in IndexedDB.
const CACHE = 'fig-v2'

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
  // Le API non passano mai dalla cache.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    // Pagina: prima la rete (per gli aggiornamenti), poi la copia in cache.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy))
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
