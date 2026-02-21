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
 * 1. Server loads persisted tokens from disk, or generates them on first startup
 * 2. Agent token written to {dataDir}/api.token (mode 0o600)
 * 3. Browser calls GET /api/auth/handshake (Origin must be localhost) → receives user token
 * 4. All /api/* requests require Authorization: Bearer <token>
 * 5. WebSocket connects with ws://localhost:PORT/ws?token=<token>
 */

import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type TokenRole = 'agent' | 'user'

let agentToken: string | null = null
let userToken: string | null = null

const AUTH_TOKENS_FILE = 'auth.tokens.json'

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function readPersistedTokens(dataDir: string): { agent: string; user: string } | null {
  const file = join(dataDir, AUTH_TOKENS_FILE)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as { agent?: unknown; user?: unknown }
    if (!isValidToken(parsed.agent) || !isValidToken(parsed.user)) return null
    return { agent: parsed.agent, user: parsed.user }
  } catch {
    return null
  }
}

function readLegacyAgentToken(dataDir: string): string | null {
  const file = join(dataDir, 'api.token')
  if (!existsSync(file)) return null
  try {
    const value = readFileSync(file, 'utf-8').trim()
    return isValidToken(value) ? value : null
  } catch {
    return null
  }
}

function writePersistedTokens(dataDir: string, agent: string, user: string): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, AUTH_TOKENS_FILE), JSON.stringify({ agent, user }), { mode: 0o600 })
}

export function generateToken(dataDir?: string): string {
  if (agentToken && userToken) return agentToken

  if (dataDir) {
    const persisted = readPersistedTokens(dataDir)
    if (persisted) {
      agentToken = persisted.agent
      userToken = persisted.user
      return agentToken
    }
  }

  agentToken = dataDir ? (readLegacyAgentToken(dataDir) ?? crypto.randomBytes(32).toString('hex')) : crypto.randomBytes(32).toString('hex')
  userToken = crypto.randomBytes(32).toString('hex')

  if (dataDir) writePersistedTokens(dataDir, agentToken, userToken)

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

/** For tests — clear all tokens so generateToken starts fresh */
export function resetTokens(): void {
  agentToken = null
  userToken = null
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname === '::ffff:127.0.0.1'
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Same-origin requests have no Origin header
  if (!origin) return true
  try {
    const url = new URL(origin)
    return isLoopbackHostname(url.hostname)
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
    return isLoopbackHostname(url.hostname)
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
