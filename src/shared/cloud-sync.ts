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

const CLOUD_API = 'https://quoroom.ai/api'
const CLOUD_MASTER_TOKEN = (process.env.QUOROOM_CLOUD_API_KEY ?? '').trim()
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
  const token = roomToken || CLOUD_MASTER_TOKEN
  if (!token) return extra
  return { ...extra, 'X-Room-Token': token }
}

export interface CloudRegistration {
  roomId: string
  name: string
  goal: string | null
  visibility?: 'public' | 'private'
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
    const res = await fetch(`${CLOUD_API}/rooms/register`, {
      method: 'POST',
      headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return
    const payload = await res.json().catch(() => ({})) as { roomToken?: string }
    if (typeof payload.roomToken === 'string' && payload.roomToken.length > 0) {
      setRoomToken(data.roomId, payload.roomToken)
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
    const res = await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(data.roomId)}/heartbeat`, {
      method: 'POST',
      headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    })
    if (res.status === 401) {
      clearRoomToken(data.roomId)
      await registerWithCloud({ roomId: data.roomId, name: data.name, goal: data.goal, visibility: 'public' })
      if (!getRoomToken(data.roomId)) return
      await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(data.roomId)}/heartbeat`, {
        method: 'POST',
        headers: cloudHeaders(data.roomId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000)
      })
    }
  } catch {
    // Fail silently
  }
}

// ─── Heartbeat timer ────────────────────────────────────────

let heartbeatInterval: ReturnType<typeof setInterval> | null = null

export interface CloudSyncOptions {
  getHeartbeatDataForPublicRooms: () => CloudHeartbeat[]
}

/**
 * Start periodic cloud heartbeat (every 5 minutes).
 * Registers and sends heartbeats for each public room.
 */
export function startCloudSync(opts: CloudSyncOptions): void {
  stopCloudSync()

  const allData = opts.getHeartbeatDataForPublicRooms()
  for (const data of allData) {
    void (async () => {
      await registerWithCloud({ roomId: data.roomId, name: data.name, goal: data.goal, visibility: 'public' })
      await sendCloudHeartbeat(data)
    })()
  }

  heartbeatInterval = setInterval(() => {
    const rooms = opts.getHeartbeatDataForPublicRooms()
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

// ─── Cloud Stations ─────────────────────────────────────────

export interface CloudStation {
  id: number
  roomId: string
  tier: string
  stationName: string
  flyAppName: string | null
  flyMachineId: string | null
  status: string
  monthlyCost: number
  currentPeriodEnd: string | null
  createdAt: string
  updatedAt: string
}

/**
 * List active stations for a room from the cloud API.
 * Returns empty array on failure (fail silently).
 */
export async function listCloudStations(cloudRoomId: string): Promise<CloudStation[]> {
  try {
    const res = await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations`, {
      headers: cloudHeaders(cloudRoomId),
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { stations: CloudStation[] }
    return data.stations ?? []
  } catch {
    return []
  }
}

/**
 * Execute a command on a cloud station.
 * Returns null on failure.
 */
export async function execOnCloudStation(
  cloudRoomId: string,
  subId: number,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  try {
    const res = await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${subId}/exec`,
      {
        method: 'POST',
        headers: cloudHeaders(cloudRoomId, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(90000)
      }
    )
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/**
 * Get logs from a cloud station.
 * Returns null on failure.
 */
export async function getCloudStationLogs(
  cloudRoomId: string,
  subId: number,
  lines?: number
): Promise<string | null> {
  try {
    const query = lines ? `?lines=${lines}` : ''
    const res = await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${subId}/logs${query}`,
      {
        headers: cloudHeaders(cloudRoomId),
        signal: AbortSignal.timeout(15000)
      }
    )
    if (!res.ok) return null
    const data = await res.json() as { logs: string }
    return data.logs ?? ''
  } catch {
    return null
  }
}

/**
 * Start a stopped cloud station.
 */
export async function startCloudStation(cloudRoomId: string, subId: number): Promise<void> {
  try {
    await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${subId}/start`,
      {
        method: 'POST',
        headers: cloudHeaders(cloudRoomId),
        signal: AbortSignal.timeout(30000)
      }
    )
  } catch {
    // Fail silently
  }
}

/**
 * Stop a running cloud station.
 */
export async function stopCloudStation(cloudRoomId: string, subId: number): Promise<void> {
  try {
    await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${subId}/stop`,
      {
        method: 'POST',
        headers: cloudHeaders(cloudRoomId),
        signal: AbortSignal.timeout(30000)
      }
    )
  } catch {
    // Fail silently
  }
}

/**
 * Delete a cloud station (cancels subscription + destroys Fly.io machine).
 */
export async function deleteCloudStation(cloudRoomId: string, subId: number): Promise<void> {
  try {
    await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/stations/${subId}`,
      {
        method: 'DELETE',
        headers: cloudHeaders(cloudRoomId),
        signal: AbortSignal.timeout(30000)
      }
    )
  } catch {
    // Fail silently
  }
}

/**
 * Cancel a cloud station subscription at period end (soft cancel — machine keeps running).
 */
export async function cancelCloudStation(cloudRoomId: string, subId: number): Promise<void> {
  try {
    await fetch(
      `${CLOUD_API}/rooms/${encodeURIComponent(cloudRoomId)}/billing/cancel/${subId}`,
      {
        method: 'POST',
        headers: cloudHeaders(cloudRoomId),
        signal: AbortSignal.timeout(30000)
      }
    )
  } catch {
    // Fail silently
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

/**
 * Fetch list of public rooms from cloud API.
 * Returns empty array on failure (fail silently).
 */
export async function fetchPublicRooms(): Promise<PublicRoom[]> {
  try {
    const res = await fetch(`${CLOUD_API}/rooms/public`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { rooms: PublicRoom[] }
    return data.rooms ?? []
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
    const res = await fetch(`${CLOUD_API}/rooms/public/${encodeURIComponent(roomId)}/feed`, {
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return []
    const data = await res.json() as { feed: PublicRoomFeedEntry[] }
    return data.feed ?? []
  } catch {
    return []
  }
}
