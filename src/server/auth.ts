/**
 * Auth token generation, validation, and CORS/Origin checking.
 *
 * Dual-token system:
 * - Agent token: written to {dataDir}/api.token, used by Claude CLI / agent processes
 * - User token: returned via GET /api/auth/handshake, used by browser UI
 *
 * In "auto" autonomy mode, user token is restricted (read-only + voting).
 * In "semi" mode, user token has full access.
 * Agent token always has full access.
 *
 * Flow:
 * 1. Server generates two 256-bit random tokens on startup
 * 2. Agent token written to {dataDir}/api.token (mode 0o600)
 * 3. Browser calls GET /api/auth/handshake (Origin must be localhost) → receives user token
 * 4. All /api/* requests require Authorization: Bearer <token>
 * 5. WebSocket connects with ws://localhost:PORT/ws?token=<token>
 */

import crypto from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type TokenRole = 'agent' | 'user'

let agentToken: string | null = null
let userToken: string | null = null

export function generateToken(): string {
  agentToken = crypto.randomBytes(32).toString('hex')
  userToken = crypto.randomBytes(32).toString('hex')
  return agentToken
}

export function getToken(): string {
  if (!agentToken) throw new Error('Token not yet generated')
  return agentToken
}

export function getUserToken(): string {
  if (!userToken) throw new Error('Token not yet generated')
  return userToken
}

/** For tests — inject known tokens */
export function setToken(token: string): void {
  agentToken = token
}

export function setUserToken(token: string): void {
  userToken = token
}

/**
 * Validate auth header and return the token role, or null if invalid.
 */
export function validateToken(authHeader: string | undefined): TokenRole | null {
  if (!agentToken || !userToken) return null
  if (!authHeader?.startsWith('Bearer ')) return null
  const provided = Buffer.from(authHeader.slice(7))

  const agentBuf = Buffer.from(agentToken)
  if (provided.length === agentBuf.length && crypto.timingSafeEqual(provided, agentBuf)) {
    return 'agent'
  }

  const userBuf = Buffer.from(userToken)
  if (provided.length === userBuf.length && crypto.timingSafeEqual(provided, userBuf)) {
    return 'user'
  }

  return null
}

export function writeTokenFile(dataDir: string, token: string, port: number): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'api.token'), token, { mode: 0o600 })
  writeFileSync(join(dataDir, 'api.port'), String(port))
}

const ALLOWED_REMOTE_ORIGINS = [
  'https://app.quoroom.ai',
  'https://quoroom-ai.github.io',
]

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Same-origin requests have no Origin header
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true
    return ALLOWED_REMOTE_ORIGINS.includes(origin)
  } catch {
    return false
  }
}

/** Localhost-only origin check, used for auth handshake. */
export function isLocalOrigin(origin: string | undefined): boolean {
  // Same-origin requests have no Origin header
  if (!origin) return true
  try {
    const url = new URL(origin)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export function setCorsHeaders(
  origin: string | undefined,
  headers: Record<string, string>
): void {
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
  headers['Access-Control-Max-Age'] = '86400'
}
