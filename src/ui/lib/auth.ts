const DEFAULT_PORT = 3700

export function getApiBase(): string {
  // Explicit env override always wins
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL
  // On localhost — use relative URLs (Vite proxy or direct serve)
  const host = location.hostname
  if (host === 'localhost' || host === '127.0.0.1') return ''
  // Remote origin (GitHub Pages) — connect to local server
  const savedPort = localStorage.getItem('quoroom_port') || String(DEFAULT_PORT)
  return `http://localhost:${savedPort}`
}

export const API_BASE = getApiBase()

let cachedToken: string | null = null

export async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken
  const res = await fetch(`${API_BASE}/api/auth/handshake`)
  if (!res.ok) throw new Error('Failed to fetch')
  const data = await res.json()
  cachedToken = data.token
  return cachedToken!
}

export function clearToken(): void {
  cachedToken = null
}
