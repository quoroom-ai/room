/**
 * Public Feed — filter room_activity for public consumption.
 *
 * Public rooms expose a curated activity feed: decisions, milestones,
 * financial events. No debug noise, plain-language summaries.
 */

import type Database from 'better-sqlite3'
import type { RoomActivityEntry, RevenueSummary } from './types'
import * as queries from './db-queries'

export interface PublicRoomProfile {
  id: number
  name: string
  goal: string | null
  status: string
  workerCount: number
  queenModel: string | null
  walletAddress: string | null
  revenue: RevenueSummary
  recentActivity: RoomActivityEntry[]
}

/**
 * Get public activity feed for a room (is_public = 1 only).
 */
export function getPublicFeed(db: Database.Database, roomId: number, limit: number = 50): RoomActivityEntry[] {
  const rows = db.prepare(
    'SELECT * FROM room_activity WHERE room_id = ? AND is_public = 1 ORDER BY created_at DESC LIMIT ?'
  ).all(roomId, limit) as Record<string, unknown>[]

  return rows.map(row => ({
    id: row.id as number,
    roomId: row.room_id as number,
    eventType: row.event_type as RoomActivityEntry['eventType'],
    actorId: row.actor_id as number | null,
    summary: row.summary as string,
    details: null, // Strip technical details from public feed
    isPublic: true,
    createdAt: row.created_at as string
  }))
}

/**
 * Get a public-facing room profile with aggregated data.
 */
export function getPublicRoomProfile(db: Database.Database, roomId: number): PublicRoomProfile {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  const workers = queries.listRoomWorkers(db, roomId)
  const queen = room.queenWorkerId ? queries.getWorker(db, room.queenWorkerId) : null
  const wallet = queries.getWalletByRoom(db, roomId)
  const revenue = queries.getRevenueSummary(db, roomId)
  const recentActivity = getPublicFeed(db, roomId, 20)

  return {
    id: room.id,
    name: room.name,
    goal: room.goal,
    status: room.status,
    workerCount: workers.length,
    queenModel: queen?.model ?? null,
    walletAddress: wallet?.address ?? null,
    revenue,
    recentActivity
  }
}
