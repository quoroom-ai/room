import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

function redirectMisroutedGoogleCallback(): boolean {
  if (location.pathname !== '/api/auth/google/callback') return false

  const configuredOrigin = (import.meta.env.VITE_CLOUD_CONTROL_ORIGIN || '').trim()
  const targetOrigin = configuredOrigin || (location.hostname === 'app.quoroom.ai' ? 'https://quoroom.ai' : '')
  if (!targetOrigin) return false

  try {
    const url = new URL(targetOrigin)
    if (url.origin === location.origin) return false
    const target = `${url.origin}${location.pathname}${location.search}${location.hash}`
    window.location.replace(target)
    return true
  } catch {
    return false
  }
}

if (redirectMisroutedGoogleCallback()) {
  // Stop booting the local app shell while callback redirect is in progress.
} else {
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
}

if ('serviceWorker' in navigator) {
  const host = location.hostname
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'

  if (isLocalhost) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) {
        void reg.unregister()
      }
    }).catch(() => {})

    if ('caches' in window) {
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).catch(() => {})
    }
  } else {
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.update().catch(() => {})
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      }
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' })
          }
        })
      })
    }).catch(() => {})
  }
}
