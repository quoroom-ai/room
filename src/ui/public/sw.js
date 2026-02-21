const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const STATIC_CACHE = `quoroom-static-${VERSION}`
const RUNTIME_CACHE = `quoroom-runtime-${VERSION}`
const PRECACHE = [
  '/offline.html',
  '/logo.png',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
]

function isCacheableResponse(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'cors')
}

function isDocumentRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document'
}

function isStaticAssetRequest(url, request) {
  if (url.origin !== self.location.origin) return false
  const path = url.pathname
  if (path.startsWith('/assets/')) return true
  if (path.startsWith('/icon-') || path === '/apple-touch-icon.png') return true
  if (path === '/manifest.webmanifest' || path === '/favicon.ico' || path === '/logo.png') return true
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'font') return true
  if (request.destination === 'image') return true
  return /\.(css|js|woff2?|png|jpe?g|svg|webp|ico)$/.test(path)
}

async function networkFirst(request, cacheName, offlineFallbackPath) {
  try {
    const response = await fetch(request)
    if (isCacheableResponse(response)) {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    if (offlineFallbackPath) {
      const fallback = await caches.match(offlineFallbackPath)
      if (fallback) return fallback
    }
    return Response.error()
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const networkPromise = fetch(request)
    .then((response) => {
      if (isCacheableResponse(response)) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => null)
  return cached || (await networkPromise) || Response.error()
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
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
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  if (!request.url.startsWith('http')) return

  const url = new URL(request.url)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return

  if (isDocumentRequest(request)) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, '/offline.html'))
    return
  }

  if (isStaticAssetRequest(url, request)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE))
    return
  }

  event.respondWith(networkFirst(request, RUNTIME_CACHE))
})
