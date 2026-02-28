import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { cleanupLegacyPwaArtifacts } from './lib/pwaCleanup'
import './styles/globals.css'

const PWA_CLEANUP_RELOAD_KEY = 'quoroom:pwa-cleanup-reload'

function redirectMisroutedGoogleCallback(): boolean {
  if (location.pathname !== '/api/auth/google/callback') return false

  const configuredOrigin = (import.meta.env.VITE_CLOUD_CONTROL_ORIGIN || '').trim()
  const targetOrigin = configuredOrigin || (location.hostname === 'app.quoroom.io' ? 'https://quoroom.io' : '')
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

function readPwaCleanupReloadMarker(): boolean {
  try {
    return sessionStorage.getItem(PWA_CLEANUP_RELOAD_KEY) === '1'
  } catch {
    return false
  }
}

function writePwaCleanupReloadMarker(): boolean {
  try {
    sessionStorage.setItem(PWA_CLEANUP_RELOAD_KEY, '1')
    return true
  } catch {
    // If sessionStorage is unavailable, avoid risking a reload loop.
    return false
  }
}

function clearPwaCleanupReloadMarker(): void {
  try {
    sessionStorage.removeItem(PWA_CLEANUP_RELOAD_KEY)
  } catch {
    // Best-effort cleanup.
  }
}

function shouldReloadAfterPwaCleanup(cleaned: boolean): boolean {
  if (!cleaned) {
    clearPwaCleanupReloadMarker()
    return false
  }

  const alreadyReloaded = readPwaCleanupReloadMarker()
  if (alreadyReloaded) {
    clearPwaCleanupReloadMarker()
    return false
  }

  return writePwaCleanupReloadMarker()
}

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}

async function boot(): Promise<void> {
  const cleaned = await cleanupLegacyPwaArtifacts()
  if (shouldReloadAfterPwaCleanup(cleaned)) {
    window.location.reload()
    return
  }

  if (redirectMisroutedGoogleCallback()) {
    // Stop booting the local app shell while callback redirect is in progress.
    return
  }

  renderApp()
}

void boot()
