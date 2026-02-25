import type Database from 'better-sqlite3'
import { execSync } from 'node:child_process'
import * as queries from './db-queries'
import { checkClaudeCliAvailable } from './claude-code'

export type ModelProvider =
  | 'claude_subscription'
  | 'codex_subscription'
  | 'openai_api'
  | 'anthropic_api'

export interface ModelAuthStatus {
  provider: ModelProvider
  mode: 'subscription' | 'api'
  credentialName: string | null
  envVar: string | null
  hasCredential: boolean
  hasEnvKey: boolean
  ready: boolean
  maskedKey: string | null
}

export function normalizeModel(model: string | null | undefined): string {
  const trimmed = model?.trim()
  return trimmed ? trimmed : 'claude'
}

export function getModelProvider(model: string | null | undefined): ModelProvider {
  const normalized = normalizeModel(model)
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
  }

  return {
    provider,
    mode: 'subscription',
    credentialName: null,
    envVar: null,
    hasCredential: false,
    hasEnvKey: false,
    ready,
    maskedKey: null
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
  const sharedRoomCred = findAnyRoomCredential(db, credentialName, roomId)
  const clerkCred = getClerkCredential(db, credentialName)
  const envKey = getEnvValue(envVar)
  const hasCredential = Boolean(roomCred || sharedRoomCred || clerkCred)
  const activeKey = roomCred || sharedRoomCred || clerkCred || envKey || null
  return {
    provider,
    mode: 'api',
    credentialName,
    envVar,
    hasCredential,
    hasEnvKey: Boolean(envKey),
    ready: Boolean(hasCredential || envKey),
    maskedKey: maskKey(activeKey)
  }
}

function maskKey(key: string | null): string | null {
  if (!key) return null
  const trimmed = key.trim()
  if (trimmed.length <= 8) return `${trimmed.slice(0, 3)}...`
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`
}

function resolveApiKey(db: Database.Database, roomId: number, credentialName: string, envVar: string): string | undefined {
  const roomCred = getRoomCredential(db, roomId, credentialName)
  if (roomCred) return roomCred
  const sharedRoomCred = findAnyRoomCredential(db, credentialName, roomId)
  if (sharedRoomCred) return sharedRoomCred
  const clerkCred = getClerkCredential(db, credentialName)
  if (clerkCred) return clerkCred
  return getEnvValue(envVar) || undefined
}

function findAnyRoomCredential(db: Database.Database, credentialName: string, excludeRoomId?: number): string | null {
  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    if (excludeRoomId != null && room.id === excludeRoomId) continue
    const value = getRoomCredential(db, room.id, credentialName)
    if (value) return value
  }
  return null
}

function getClerkCredential(db: Database.Database, credentialName: string): string | null {
  if (credentialName === 'openai_api_key') {
    return queries.getClerkApiKey(db, 'openai_api')
  }
  if (credentialName === 'anthropic_api_key') {
    return queries.getClerkApiKey(db, 'anthropic_api')
  }
  return null
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
  const cmd = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  try {
    execSync(`"${cmd}" --version`, { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}
