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
import { getMachineId } from './telemetry'

const CLOUD_API = 'https://quoroom.ai/api'

export interface CloudRegistration {
  roomId: string
  name: string
  goal: string | null
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

/**
 * Register room with cloud. Called once when public mode is enabled.
 */
export async function registerWithCloud(data: CloudRegistration): Promise<void> {
  try {
    await fetch(`${CLOUD_API}/rooms/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    })
  } catch {
    // Fail silently — cloud unavailability must never affect local operation
  }
}

/**
 * Send heartbeat to cloud. Called every 5 minutes when public mode is enabled.
 */
export async function sendCloudHeartbeat(data: CloudHeartbeat): Promise<void> {
  try {
    await fetch(`${CLOUD_API}/rooms/${encodeURIComponent(data.roomId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    })
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
    registerWithCloud({ roomId: data.roomId, name: data.name, goal: data.goal })
    sendCloudHeartbeat(data)
  }

  heartbeatInterval = setInterval(() => {
    const rooms = opts.getHeartbeatDataForPublicRooms()
    for (const data of rooms) {
      sendCloudHeartbeat(data)
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
