import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
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
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
}

if ('serviceWorker' in navigator) {
  const fallbackBuildId = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'dev'
  const swBuildId = (import.meta.env.VITE_SW_BUILD_ID || fallbackBuildId).trim()
  const swUrl = `/sw.js?v=${encodeURIComponent(swBuildId)}`
  const host = location.hostname
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'

  if (isLocalhost && import.meta.env.DEV) {
    // Dev only: unregister SW to avoid stale caches during development.
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
    const hadController = !!navigator.serviceWorker.controller
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return // First install — don't reload.
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })

    navigator.serviceWorker.register(swUrl).then((registration) => {
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
