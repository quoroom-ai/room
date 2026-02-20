import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { canModify, performModification, revertModification, getModificationHistory, _resetRateLimit } from '../self-mod'

let db: Database.Database
let roomId: number
let workerId: number

beforeEach(() => {
  db = initTestDb()
  _resetRateLimit()
  const room = queries.createRoom(db, 'Test Room', 'Goal')
  roomId = room.id
  const worker = queries.createWorker(db, { name: 'Queen', systemPrompt: 'prompt', roomId })
  workerId = worker.id
})

describe('canModify', () => {
  it('allows normal file paths', () => {
    expect(canModify(workerId, '/skills/web-scraping.md')).toEqual({ allowed: true })
  })

  it('blocks private key paths', () => {
    const result = canModify(workerId, '/wallets/private_key.txt')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Forbidden')
  })

  it('blocks wallet encrypted paths', () => {
    expect(canModify(workerId, '/wallets/wallet_encrypted.db').allowed).toBe(false)
  })

  it('blocks .env files', () => {
    expect(canModify(workerId, '/project/.env').allowed).toBe(false)
  })

  it('blocks self-mod.ts', () => {
    expect(canModify(workerId, '/src/shared/self-mod.ts').allowed).toBe(false)
    expect(canModify(workerId, '/src/shared/self_mod.ts').allowed).toBe(false)
  })

  it('blocks credential value paths', () => {
    expect(canModify(workerId, '/data/credential_value.json').allowed).toBe(false)
  })

  it('enforces rate limiting', () => {
    performModification(db, roomId, workerId, '/test.md', null, 'abc', 'Test')
    const result = canModify(workerId, '/test2.md')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Rate limited')
  })
})

describe('performModification', () => {
  it('creates audit entry', () => {
    const entry = performModification(db, roomId, workerId, '/skills/new.md', null, 'abc123', 'Created new skill')
    expect(entry.filePath).toBe('/skills/new.md')
    expect(entry.oldHash).toBeNull()
    expect(entry.newHash).toBe('abc123')
    expect(entry.reason).toBe('Created new skill')
    expect(entry.reversible).toBe(true)
    expect(entry.reverted).toBe(false)
  })

  it('throws for forbidden path', () => {
    expect(() => performModification(db, roomId, workerId, '/wallets/private_key.dat', null, null, 'Test'))
      .toThrow('Forbidden')
  })

  it('throws when rate limited', () => {
    performModification(db, roomId, workerId, '/a.md', null, null, 'First')
    expect(() => performModification(db, roomId, workerId, '/b.md', null, null, 'Second'))
      .toThrow('Rate limited')
  })

  it('logs room activity', () => {
    performModification(db, roomId, workerId, '/skills/test.md', null, 'hash', 'Test mod')
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.some(a => a.summary.includes('Self-mod'))).toBe(true)
  })
})

describe('revertModification', () => {
  it('marks modification as reverted', () => {
    const entry = performModification(db, roomId, workerId, '/test.md', 'old', 'new', 'Test')
    revertModification(db, entry.id)

    const history = getModificationHistory(db, roomId)
    const reverted = history.find(h => h.id === entry.id)!
    expect(reverted.reverted).toBe(true)
  })

  it('throws for nonexistent entry', () => {
    expect(() => revertModification(db, 999)).toThrow('not found')
  })
})

describe('getModificationHistory', () => {
  it('returns history for room', () => {
    performModification(db, roomId, workerId, '/a.md', null, 'h1', 'First')
    _resetRateLimit()
    performModification(db, roomId, workerId, '/b.md', null, 'h2', 'Second')

    const history = getModificationHistory(db, roomId)
    expect(history).toHaveLength(2)
  })

  it('returns empty for room with no mods', () => {
    expect(getModificationHistory(db, roomId)).toEqual([])
  })
})
