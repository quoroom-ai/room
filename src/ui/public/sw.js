const CACHE_NAME = 'quoroom-v3'
const SHELL = ['/logo.png', '/favicon.ico']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // Skip non-http(s), API, and WebSocket requests
  if (!request.url.startsWith('http')) return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  // Never cache HTML documents to avoid stale app shells after deploys.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(fetch(request))
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok) return response
        const clone = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        return response
      })
      .catch(async () => (await caches.match(request)) || Response.error())
  )
})
