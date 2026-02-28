import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/globals.css'

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
