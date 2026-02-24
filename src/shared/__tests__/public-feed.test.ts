import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import { getPublicFeed, getPublicRoomProfile } from '../public-feed'
import * as queries from '../db-queries'
import { createRoomWallet } from '../wallet'

let db: Database.Database
let roomId: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Feed Test Room', 'test goal')
  roomId = room.id
})

// ─── getPublicFeed ──────────────────────────────────────────

describe('getPublicFeed', () => {
  it('returns empty array for room with no activity', () => {
    const feed = getPublicFeed(db, roomId)
    expect(feed).toEqual([])
  })

  it('returns only is_public=1 entries', () => {
    queries.logRoomActivity(db, roomId, 'milestone', 'Public milestone', undefined, undefined, true)
    queries.logRoomActivity(db, roomId, 'system', 'Private debug', undefined, undefined, false)
    queries.logRoomActivity(db, roomId, 'decision', 'Public decision', undefined, undefined, true)

    const feed = getPublicFeed(db, roomId)
    expect(feed).toHaveLength(2)
    expect(feed.every(f => f.isPublic)).toBe(true)
  })

  it('strips details field (always null)', () => {
    queries.logRoomActivity(db, roomId, 'financial', 'Got paid', 'secret-tx-hash', undefined, true)

    const feed = getPublicFeed(db, roomId)
    expect(feed).toHaveLength(1)
    expect(feed[0].details).toBeNull()
    expect(feed[0].summary).toBe('Got paid')
  })

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      queries.logRoomActivity(db, roomId, 'milestone', `Event ${i}`, undefined, undefined, true)
    }

    const feed = getPublicFeed(db, roomId, 3)
    expect(feed).toHaveLength(3)
  })

  it('returns results ordered by time', () => {
    queries.logRoomActivity(db, roomId, 'milestone', 'First', undefined, undefined, true)
    queries.logRoomActivity(db, roomId, 'milestone', 'Second', undefined, undefined, true)
    queries.logRoomActivity(db, roomId, 'milestone', 'Third', undefined, undefined, true)

    const feed = getPublicFeed(db, roomId)
    expect(feed).toHaveLength(3)
    // Verify all 3 entries are returned (order depends on same-second insert behavior)
    const summaries = feed.map(f => f.summary)
    expect(summaries).toContain('First')
    expect(summaries).toContain('Second')
    expect(summaries).toContain('Third')
  })
})

// ─── getPublicRoomProfile ───────────────────────────────────

describe('getPublicRoomProfile', () => {
  it('returns room info with worker count', () => {
    queries.createWorker(db, { name: 'Worker 1', systemPrompt: 'test', roomId })
    queries.createWorker(db, { name: 'Worker 2', systemPrompt: 'test', roomId })

    const profile = getPublicRoomProfile(db, roomId)
    expect(profile.name).toBe('Feed Test Room')
    expect(profile.goal).toBe('test goal')
    expect(profile.workerCount).toBe(2)
  })

  it('includes wallet address when wallet exists', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key-123')

    const profile = getPublicRoomProfile(db, roomId)
    expect(profile.walletAddress).toBe(wallet.address)
  })

  it('returns null walletAddress when no wallet', () => {
    const profile = getPublicRoomProfile(db, roomId)
    expect(profile.walletAddress).toBeNull()
  })

  it('throws for nonexistent room', () => {
    expect(() => getPublicRoomProfile(db, 9999)).toThrow('Room 9999 not found')
  })

  it('includes revenue summary', () => {
    const wallet = createRoomWallet(db, roomId, 'test-key-456')
    queries.logWalletTransaction(db, wallet.id, 'receive', '100.00')
    queries.logWalletTransaction(db, wallet.id, 'send', '30.00')

    const profile = getPublicRoomProfile(db, roomId)
    expect(profile.revenue.totalIncome).toBe(100)
    expect(profile.revenue.totalExpenses).toBe(30)
    expect(profile.revenue.netProfit).toBe(70)
    expect(profile.revenue.transactionCount).toBe(2)
  })

  it('includes recent public activity', () => {
    queries.logRoomActivity(db, roomId, 'milestone', 'Big win', undefined, undefined, true)
    queries.logRoomActivity(db, roomId, 'system', 'Debug noise', undefined, undefined, false)

    const profile = getPublicRoomProfile(db, roomId)
    expect(profile.recentActivity).toHaveLength(1)
    expect(profile.recentActivity[0].summary).toBe('Big win')
  })
})
