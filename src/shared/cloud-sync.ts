/**
 * Cloud sync — register room with quoroom.ai and send periodic heartbeats.
 *
 * When public_mode is enabled, the room engine:
 * 1. Registers with POST /api/rooms/register
 * 2. Sends heartbeats every 5 minutes with room stats + mode badge
 *
 * All requests fail silently — cloud availability never affects local operation.
 */

import { createHash } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { getMachineId } from './telemetry'

function getCloudApi(): string {
  return (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.io/api').replace(/\/$/, '')
}
const TOKEN_FILE_NAME = 'cloud-room-tokens.json'

type CloudTokenStore = Record<string, string>
let cachedTokens: CloudTokenStore | null = null

function getCloudTokenFilePath(): string {
  const explicitDataDir = process.env.QUOROOM_DATA_DIR?.trim()
  if (explicitDataDir) return join(explicitDataDir, TOKEN_FILE_NAME)

  const dbPath = process.env.QUOROOM_DB_PATH?.trim()
  if (dbPath) return join(dirname(dbPath), TOKEN_FILE_NAME)

  return join(homedir(), '.quoroom', TOKEN_FILE_NAME)
}

function loadTokenStore(): CloudTokenStore {
  if (cachedTokens) return cachedTokens
  const filePath = getCloudTokenFilePath()
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { rooms?: Record<string, string> }
    cachedTokens = parsed.rooms ?? {}
  } catch {
    cachedTokens = {}
  }
  return cachedTokens
}

function saveTokenStore(): void {
  const filePath = getCloudTokenFilePath()
  mkdirSync(dirname(filePath), { recursive: true })
  const payload = JSON.stringify({ rooms: loadTokenStore() }, null, 2) + '\n'
  writeFileSync(filePath, payload, { mode: 0o600 })
}

function getRoomToken(roomId: string): string | undefined {
  return loadTokenStore()[roomId]
}

export function getStoredCloudRoomToken(roomId: string): string | null {
  const token = getRoomToken(roomId)
  return typeof token === 'string' && token.trim() ? token : null
}

function setRoomToken(roomId: string, token: string): void {
  loadTokenStore()[roomId] = token
  saveTokenStore()
}

function clearRoomToken(roomId: string): void {
  const store = loadTokenStore()
  if (!(roomId in store)) return
  delete store[roomId]
  saveTokenStore()
}

function cloudHeaders(roomId?: string, extra: Record<string, string> = {}): Record<string, string> {
  const roomToken = roomId ? getRoomToken(roomId) : undefined
  if (!roomToken) return extra
  return { ...extra, 'X-Room-Token': roomToken }
}

export interface CloudRegistration {
  roomId: string
  name: string
  goal: string | null
  visibility?: 'public' | 'private'
  referredByCode?: string | null
  keeperReferralCode?: string | null
}

export interface CloudHeartbeat {
  roomId: string
  name: string
  goal: string | null
  mode: 'auto' | 'semi'
  workerCount: number
  taskCount: number
  earnings: string
  version: string
  queenModel: string | null
  workers: Array<{ name: string; state: string; model?: string }>
  visibility?: 'public' | 'private'
  referredByCode?: string | null
  keeperReferralCode?: string | null
}

export async function ensureCloudRoomToken(data: CloudRegistration): Promise<boolean> {
  if (getRoomToken(data.roomId)) return true
  await registerWithCloud(data)
  return Boolean(getRoomToken(data.roomId))
}

/**
 * Register room with cloud. Called once when public mode is enabled.
 */
export async function registerWithCloud(data: CloudRegistration): Promise<void> {
  try {
    const payload = {
      ...data,
      inviteCode: data.referredByCode ?? null,
      keeperReferralCode: data.keeperReferralCode ?? null,
    }
    const res = await fetch(`${getCloudApi()}/rooms/register`, {
      method: 'POST',
      headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return
    const result = await res.json().catch(() => ({})) as { roomToken?: string }
    if (typeof result.roomToken === 'string' && result.roomToken.length > 0) {
      setRoomToken(data.roomId, result.roomToken)
    }
  } catch {
    // Fail silently — cloud unavailability must never affect local operation
  }
}

/**
 * Send heartbeat to cloud. Called every 5 minutes when public mode is enabled.
 */
export async function sendCloudHeartbeat(data: CloudHeartbeat): Promise<void> {
  try {
    const payload = {
      ...data,
      inviteCode: data.referredByCode ?? null,
      keeperReferralCode: data.keeperReferralCode ?? null,
    }
    const res = await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(data.roomId)}/heartbeat`, {
      method: 'POST',
      headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    })
    if (res.status === 401) {
      clearRoomToken(data.roomId)
      await registerWithCloud({
        roomId: data.roomId,
        name: data.name,
        goal: data.goal,
        visibility: data.visibility ?? 'public',
        referredByCode: data.referredByCode,
        keeperReferralCode: data.keeperReferralCode,
      })
      if (!getRoomToken(data.roomId)) return
      await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(data.roomId)}/heartbeat`, {
        method: 'POST',
        headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      })
    }
  } catch {
    // Fail silently
  }
}

/**
 * Push a single activity event to cloud for the public feed.
 * Fails silently — never blocks local operation.
 */
export async function pushActivityToCloud(
  cloudRoomId: string,
  eventType: string,
  summary: string
): Promise<void> {
  try {
    await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(cloudRoomId)}/activity`, {
      method: 'POST',
      headers: cloudHeaders(cloudRoomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ eventType, summary, isPublic: true }),
      signal: AbortSignal.timeout(5000)
    })
  } catch {
    // Fail silently
  }
}

// ─── Heartbeat timer ────────────────────────────────────────

let heartbeatInterval: ReturnType<typeof setInterval> | null = null

export interface CloudSyncOptions {
  getHeartbeatData: () => CloudHeartbeat[]
}

/**
 * Start periodic cloud heartbeat (every 5 minutes).
 * Registers and sends heartbeats for each public room.
 */
export function startCloudSync(opts: CloudSyncOptions): void {
  stopCloudSync()

  const allData = opts.getHeartbeatData()
  for (const data of allData) {
    void (async () => {
      await registerWithCloud({
        roomId: data.roomId,
        name: data.name,
        goal: data.goal,
        visibility: data.visibility ?? 'public',
        referredByCode: data.referredByCode,
        keeperReferralCode: data.keeperReferralCode,
      })
      await sendCloudHeartbeat(data)
    })()
  }

  heartbeatInterval = setInterval(() => {
    const rooms = opts.getHeartbeatData()
    for (const data of rooms) {
      void sendCloudHeartbeat(data)
    }
  }, 5 * 60 * 1000)
}

/**
 * Stop cloud heartbeat. Called when public mode is disabled.
 */
export function stopCloudSync(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

/**
 * Get the stable room identifier for cloud registration.
 * Uses the same machine ID as telemetry (SHA-256 hash, anonymous).
 */
export function getRoomId(): string {
  return getMachineId()
}

/**
 * Get a per-room cloud ID for multi-room heartbeats.
 * Combines the machine ID with the local room DB ID.
 */
export function getRoomCloudId(dbRoomId: number): string {
  const machineId = getMachineId()
  return createHash('sha256')
    .update(`${machineId}:${dbRoomId}`)
    .digest('hex')
    .slice(0, 32)
}

// ─── Cloud billing helpers ──────────────────────────────────

/**
 * Get a Coinbase On-Ramp URL for topping up a wallet with a credit card.
 * Returns { onrampUrl } or null on failure.
 */
export async function getCloudOnrampUrl(
  cloudRoomId: string,
  walletAddress: string,
  amount?: number
): Promise<{ onrampUrl: string } | null> {
  try {
    const params = new URLSearchParams({ address: walletAddress })
    if (amount) params.set('amount', String(amount))
    const res = await fetch(
      `${getCloudApi()}/rooms/${encodeURIComponent(cloudRoomId)}/billing/onramp-url?${params}`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!res.ok) return null
    return res.json() as Promise<{ onrampUrl: string }>
  } catch {
    return null
  }
}

// ─── Inter-room messaging ───────────────────────────────────

export interface CloudRoomMessage {
  id: number
  fromRoomId: string
  toRoomId: string
  subject: string
  body: string
  status: string
  createdAt: string
}

/**
 * Send an inter-room message through cloud relay.
 * Returns true on success.
 */
export async function sendCloudRoomMessage(
  fromRoomId: string,
  toRoomId: string,
  subject: string,
  body: string
): Promise<boolean> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/message`, {
      method: 'POST',
      headers: cloudHeaders(fromRoomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ fromRoomId, toRoomId, subject, body }),
      signal: AbortSignal.timeout(10000)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Fetch pending inter-room messages for a room.
 * Returns empty array on failure.
 */
export async function fetchCloudRoomMessages(roomId: string): Promise<CloudRoomMessage[]> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(roomId)}/messages`, {
      headers: cloudHeaders(roomId),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { messages: CloudRoomMessage[] }
    return data.messages ?? []
  } catch {
    return []
  }
}

// ─── Cross-Room Learning ────────────────────────────────────

export interface PublicRoom {
  room_id: string
  name: string
  goal: string | null
  mode: string
  worker_count: number
  earnings: string
}

const PUBLIC_ROOMS_CACHE_MS = 30_000
let cachedPublicRooms: { value: PublicRoom[]; expiresAt: number } | null = null

/**
 * Fetch list of public rooms from cloud API.
 * Returns empty array on failure (fail silently).
 */
export async function fetchPublicRooms(): Promise<PublicRoom[]> {
  if (cachedPublicRooms && Date.now() < cachedPublicRooms.expiresAt) {
    return cachedPublicRooms.value
  }

  try {
    const res = await fetch(`${getCloudApi()}/rooms/public`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { rooms: PublicRoom[] }
    const rooms = data.rooms ?? []
    cachedPublicRooms = {
      value: rooms,
      expiresAt: Date.now() + PUBLIC_ROOMS_CACHE_MS
    }
    return rooms
  } catch {
    return []
  }
}

export interface PublicRoomFeedEntry {
  event_type: string
  summary: string
  created_at: string
}

/**
 * Fetch activity feed for a specific public room.
 * Returns empty array on failure (fail silently).
 */
export async function fetchRoomFeed(roomId: string): Promise<PublicRoomFeedEntry[]> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/public/${encodeURIComponent(roomId)}/feed`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { feed: PublicRoomFeedEntry[] }
    return data.feed ?? []
  } catch {
    return []
  }
}

// ─── Invite & Referral Network ──────────────────────────────

export interface CloudInvite {
  inviteCode: string
  inviteUrl: string
  usedCount: number
  maxUses: number | null
  isActive: boolean
  expiresAt: string | null
  createdAt: string
}

export interface ReferredRoom {
  roomId: string
  visibility: 'public' | 'private'
  name?: string
  goal?: string
  workerCount?: number
  taskCount?: number
  earnings?: string
  queenModel?: string | null
  workers?: Array<{ name: string; state: string }>
  online?: boolean
  registeredAt?: string
}

/**
 * Create an invite link via cloud API.
 * Returns invite code and URL on success, null on failure.
 */
export async function createCloudInvite(
  cloudRoomId: string,
  options?: { maxUses?: number; expiresInDays?: number }
): Promise<{ inviteCode: string; inviteUrl: string } | null> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(cloudRoomId)}/invites`, {
      method: 'POST',
      headers: cloudHeaders(cloudRoomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(options ?? {}),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    const data = await res.json() as { inviteCode: string; inviteUrl: string }
    return data.inviteCode ? data : null
  } catch {
    return null
  }
}

/**
 * List invite links for a room.
 * Returns empty array on failure.
 */
export async function listCloudInvites(cloudRoomId: string): Promise<CloudInvite[]> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(cloudRoomId)}/invites`, {
      headers: cloudHeaders(cloudRoomId),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { invites: CloudInvite[] }
    return data.invites ?? []
  } catch {
    return []
  }
}

/**
 * Fetch rooms referred by this room (the room's network).
 * Returns empty array on failure.
 */
export async function fetchReferredRooms(cloudRoomId: string): Promise<ReferredRoom[]> {
  try {
    const res = await fetch(`${getCloudApi()}/rooms/${encodeURIComponent(cloudRoomId)}/network`, {
      headers: cloudHeaders(cloudRoomId),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { referredRooms: ReferredRoom[]; totalCount: number }
    return data.referredRooms ?? []
  } catch {
    return []
  }
}
