import type Database from 'better-sqlite3'
import { execSync } from 'node:child_process'
import * as queries from './db-queries'
import { checkClaudeCliAvailable } from './claude-code'
import { isOllamaAvailable } from './ollama-ensure'

export type ModelProvider =
  | 'claude_subscription'
  | 'codex_subscription'
  | 'openai_api'
  | 'anthropic_api'
  | 'ollama'

export interface ModelAuthStatus {
  provider: ModelProvider
  mode: 'subscription' | 'api'
  credentialName: string | null
  envVar: string | null
  hasCredential: boolean
  hasEnvKey: boolean
  ready: boolean
}

export function normalizeModel(model: string | null | undefined): string {
  const trimmed = model?.trim()
  return trimmed ? trimmed : 'claude'
}

export function getModelProvider(model: string | null | undefined): ModelProvider {
  const normalized = normalizeModel(model)
  if (normalized.startsWith('ollama:')) return 'ollama'
  if (normalized === 'codex' || normalized.startsWith('codex:')) return 'codex_subscription'
  if (normalized === 'openai' || normalized.startsWith('openai:')) return 'openai_api'
  if (normalized === 'anthropic' || normalized.startsWith('anthropic:') || normalized.startsWith('claude-api:')) {
    return 'anthropic_api'
  }
  return 'claude_subscription'
}

export async function getModelAuthStatus(db: Database.Database, roomId: number, model: string | null | undefined): Promise<ModelAuthStatus> {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return resolveApiAuthStatus(db, roomId, 'openai_api_key', 'OPENAI_API_KEY', provider)
  }
  if (provider === 'anthropic_api') {
    return resolveApiAuthStatus(db, roomId, 'anthropic_api_key', 'ANTHROPIC_API_KEY', provider)
  }

  let ready = false
  if (provider === 'claude_subscription') {
    ready = checkClaudeCliAvailable().available
  } else if (provider === 'codex_subscription') {
    ready = checkCodexCliAvailable()
  } else if (provider === 'ollama') {
    ready = await cachedIsOllamaAvailable()
  }

  return {
    provider,
    mode: 'subscription',
    credentialName: null,
    envVar: null,
    hasCredential: false,
    hasEnvKey: false,
    ready
  }
}

export function resolveApiKeyForModel(db: Database.Database, roomId: number, model: string | null | undefined): string | undefined {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return resolveApiKey(db, roomId, 'openai_api_key', 'OPENAI_API_KEY')
  }
  if (provider === 'anthropic_api') {
    return resolveApiKey(db, roomId, 'anthropic_api_key', 'ANTHROPIC_API_KEY')
  }
  return undefined
}

function resolveApiAuthStatus(
  db: Database.Database,
  roomId: number,
  credentialName: string,
  envVar: string,
  provider: ModelProvider
): ModelAuthStatus {
  const roomCred = getRoomCredential(db, roomId, credentialName)
  const envKey = getEnvValue(envVar)
  return {
    provider,
    mode: 'api',
    credentialName,
    envVar,
    hasCredential: Boolean(roomCred),
    hasEnvKey: Boolean(envKey),
    ready: Boolean(roomCred || envKey)
  }
}

function resolveApiKey(db: Database.Database, roomId: number, credentialName: string, envVar: string): string | undefined {
  const roomCred = getRoomCredential(db, roomId, credentialName)
  if (roomCred) return roomCred
  return getEnvValue(envVar) || undefined
}

function getRoomCredential(db: Database.Database, roomId: number, credentialName: string): string | null {
  try {
    const credential = queries.getCredentialByName(db, roomId, credentialName)
    if (!credential) return null
    const value = (credential.valueEncrypted || '').trim()
    // If decryption failed, value stays encrypted (enc:v1:*), which is unusable as an API key.
    if (!value || value.startsWith('enc:v1:')) return null
    return value
  } catch {
    return null
  }
}

function getEnvValue(envVar: string): string {
  return (process.env[envVar] || '').trim()
}

function checkCodexCliAvailable(): boolean {
  try {
    execSync('codex --version', { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

let ollamaCache: { value: boolean; at: number } | null = null
const OLLAMA_CACHE_MS = 30_000

async function cachedIsOllamaAvailable(): Promise<boolean> {
  if (ollamaCache && Date.now() - ollamaCache.at < OLLAMA_CACHE_MS) return ollamaCache.value
  const available = await isOllamaAvailable()
  ollamaCache = { value: available, at: Date.now() }
  return available
}

export function invalidateOllamaCache(): void {
  ollamaCache = null
}
