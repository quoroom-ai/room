import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { announce, object, vote, keeperVote, checkExpiredDecisions, getRoomVoters } from '../quorum'

let db: Database.Database
let roomId: number
let queenId: number
let worker1Id: number
let worker2Id: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Test Room', 'Goal')
  roomId = room.id
  const queen = queries.createWorker(db, { name: 'Queen', systemPrompt: 'Queen prompt', roomId })
  queenId = queen.id
  const w1 = queries.createWorker(db, { name: 'Worker 1', systemPrompt: 'W1 prompt', roomId })
  worker1Id = w1.id
  const w2 = queries.createWorker(db, { name: 'Worker 2', systemPrompt: 'W2 prompt', roomId })
  worker2Id = w2.id
})

describe('announce', () => {
  it('creates an announced decision with effective_at', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Build a SaaS product',
      decisionType: 'strategy'
    })
    expect(decision.status).toBe('announced')
    expect(decision.proposal).toBe('Build a SaaS product')
    expect(decision.decisionType).toBe('strategy')
    expect(decision.effectiveAt).not.toBeNull()
  })

  it('uses custom delayMinutes', () => {
    const before = Date.now()
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Custom delay',
      decisionType: 'strategy',
      delayMinutes: 30
    })
    const effectiveMs = new Date(decision.effectiveAt!).getTime()
    // Should be ~30 minutes in the future (allow 5s tolerance)
    expect(effectiveMs).toBeGreaterThan(before + 29 * 60 * 1000)
    expect(effectiveMs).toBeLessThan(before + 31 * 60 * 1000)
  })

  it('auto-approves low_impact decisions', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Update a skill',
      decisionType: 'low_impact'
    })
    expect(decision.status).toBe('approved')
    expect(decision.result).toBe('Auto-approved')
  })

  it('throws for nonexistent room', () => {
    expect(() => announce(db, {
      roomId: 999, proposerId: queenId,
      proposal: 'Test', decisionType: 'strategy'
    })).toThrow('Room 999 not found')
  })

  it('logs activity on announcement', () => {
    announce(db, {
      roomId, proposerId: queenId,
      proposal: 'New direction',
      decisionType: 'strategy'
    })
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.length).toBeGreaterThan(0)
    expect(activity[0].eventType).toBe('decision')
  })

  it('resource decisions are announced (not auto-approved)', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Allocate resources',
      decisionType: 'resource'
    })
    expect(decision.status).toBe('announced')
  })
})

describe('object', () => {
  it('sets status to objected with reason', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Risky plan',
      decisionType: 'strategy'
    })
    const objected = object(db, decision.id, worker1Id, 'Too risky')
    expect(objected.status).toBe('objected')
    expect(objected.result).toContain('Objected by worker')
    expect(objected.result).toContain('Too risky')
  })

  it('throws when decision is not announced', () => {
    // Auto-approved decision (low_impact)
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Auto thing',
      decisionType: 'low_impact'
    })
    expect(() => object(db, decision.id, worker1Id, 'Nope'))
      .toThrow('is not open for objection')
  })

  it('throws when decision is already objected', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Double objection test',
      decisionType: 'strategy'
    })
    object(db, decision.id, worker1Id, 'First objection')
    expect(() => object(db, decision.id, worker2Id, 'Second objection'))
      .toThrow('is not open for objection')
  })

  it('throws for nonexistent decision', () => {
    expect(() => object(db, 999, worker1Id, 'No such decision'))
      .toThrow('Decision 999 not found')
  })

  it('logs activity on objection', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Will be objected',
      decisionType: 'resource'
    })
    object(db, decision.id, worker1Id, 'Bad idea')
    const activity = queries.getRoomActivity(db, roomId)
    const objectionLog = activity.find(a => a.summary.includes('Objected'))
    expect(objectionLog).toBeDefined()
  })
})

describe('vote (backward compatibility with voting decisions)', () => {
  it('casts a vote on a voting-status decision', () => {
    // Manually create a legacy voting decision
    const decision = queries.createDecision(
      db, roomId, queenId, 'Legacy vote', 'strategy', 'majority'
    )
    const v = vote(db, decision.id, queenId, 'yes', 'Looks good')
    expect(v.vote).toBe('yes')
    expect(v.reasoning).toBe('Looks good')
  })

  it('throws on double vote', () => {
    const decision = queries.createDecision(
      db, roomId, queenId, 'Legacy double', 'strategy', 'majority'
    )
    vote(db, decision.id, queenId, 'yes')
    expect(() => vote(db, decision.id, queenId, 'no')).toThrow()
  })

  it('throws when decision is not voting', () => {
    // announced decision is not open for voting
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Not for voting',
      decisionType: 'strategy'
    })
    expect(() => vote(db, decision.id, queenId, 'yes'))
      .toThrow('is not open for voting')
  })

  it('throws when decision is auto-approved', () => {
    const decision = announce(db, {
      roomId, proposerId: queenId,
      proposal: 'Auto', decisionType: 'low_impact'
    })
    expect(() => vote(db, decision.id, queenId, 'yes'))
      .toThrow('is not open for voting')
  })
})

describe('checkExpiredDecisions', () => {
  it('auto-approves announced decisions past effective_at', () => {
    // Create an announcement with effective_at in the past (local time format)
    const past = new Date(Date.now() - 60000)
    const localTimeStr = [
      past.getFullYear(),
      String(past.getMonth() + 1).padStart(2, '0'),
      String(past.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(past.getHours()).padStart(2, '0'),
      String(past.getMinutes()).padStart(2, '0'),
      String(past.getSeconds()).padStart(2, '0')
    ].join(':')

    const decision = queries.createAnnouncement(
      db, roomId, queenId, 'Should become effective', 'strategy', localTimeStr
    )

    const count = checkExpiredDecisions(db)
    expect(count).toBe(1)

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('effective')
    expect(resolved.result).toContain('No objections')
  })

  it('does not touch announced decisions still within their window', () => {
    // Create an announcement with effective_at in the future
    const future = new Date(Date.now() + 600000)
    const futureTimeStr = [
      future.getFullYear(),
      String(future.getMonth() + 1).padStart(2, '0'),
      String(future.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(future.getHours()).padStart(2, '0'),
      String(future.getMinutes()).padStart(2, '0'),
      String(future.getSeconds()).padStart(2, '0')
    ].join(':')

    const decision = queries.createAnnouncement(
      db, roomId, queenId, 'Still pending', 'strategy', futureTimeStr
    )

    const count = checkExpiredDecisions(db)
    expect(count).toBe(0)

    const still = queries.getDecision(db, decision.id)!
    expect(still.status).toBe('announced')
  })

  it('handles legacy expired voting decisions', () => {
    const past = new Date(Date.now() - 60000)
    const localTimeStr = [
      past.getFullYear(),
      String(past.getMonth() + 1).padStart(2, '0'),
      String(past.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(past.getHours()).padStart(2, '0'),
      String(past.getMinutes()).padStart(2, '0'),
      String(past.getSeconds()).padStart(2, '0')
    ].join(':')

    const decision = queries.createDecision(
      db, roomId, queenId, 'Expired voting proposal', 'strategy', 'majority',
      localTimeStr
    )

    const count = checkExpiredDecisions(db)
    expect(count).toBe(1)

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('expired')
  })

  it('returns 0 when no expired decisions', () => {
    expect(checkExpiredDecisions(db)).toBe(0)
  })

  it('processes both announced and expired voting in same sweep', () => {
    const past = new Date(Date.now() - 60000)
    const localTimeStr = [
      past.getFullYear(),
      String(past.getMonth() + 1).padStart(2, '0'),
      String(past.getDate()).padStart(2, '0')
    ].join('-') + ' ' + [
      String(past.getHours()).padStart(2, '0'),
      String(past.getMinutes()).padStart(2, '0'),
      String(past.getSeconds()).padStart(2, '0')
    ].join(':')

    // One announced past effective_at
    queries.createAnnouncement(
      db, roomId, queenId, 'Effective announcement', 'strategy', localTimeStr
    )
    // One legacy voting past timeout
    queries.createDecision(
      db, roomId, queenId, 'Expired vote', 'resource', 'majority', localTimeStr
    )

    const count = checkExpiredDecisions(db)
    expect(count).toBe(2)
  })
})

describe('keeperVote', () => {
  describe('with announced decisions (new model)', () => {
    it('keeper yes approves announced decision immediately', () => {
      const decision = announce(db, {
        roomId, proposerId: queenId,
        proposal: 'Keeper approves',
        decisionType: 'strategy'
      })
      const resolved = keeperVote(db, decision.id, 'yes')
      expect(resolved.status).toBe('effective')
      expect(resolved.result).toBe('Keeper approved')
    })

    it('keeper no objects announced decision', () => {
      const decision = announce(db, {
        roomId, proposerId: queenId,
        proposal: 'Keeper objects',
        decisionType: 'strategy'
      })
      const resolved = keeperVote(db, decision.id, 'no')
      expect(resolved.status).toBe('objected')
      expect(resolved.result).toBe('Keeper objected')
    })

    it('keeper abstain approves announced decision', () => {
      const decision = announce(db, {
        roomId, proposerId: queenId,
        proposal: 'Keeper abstains on announce',
        decisionType: 'resource'
      })
      const resolved = keeperVote(db, decision.id, 'abstain')
      expect(resolved.status).toBe('effective')
      expect(resolved.result).toBe('Keeper approved')
    })
  })

  describe('with voting decisions (legacy model)', () => {
    let tinyRoomId: number
    let tinyQueenId: number

    let smallRoomId: number
    let smallQueenId: number
    let smallWorkerId: number

    beforeEach(() => {
      // Tiny room: just the queen (stage 1 -- keeper + queen = 2 members)
      const tinyRoom = queries.createRoom(db, 'Tiny Room', 'Goal')
      tinyRoomId = tinyRoom.id
      const tinyQueen = queries.createWorker(db, { name: 'Queen', systemPrompt: 'Queen prompt', roomId: tinyRoomId })
      tinyQueenId = tinyQueen.id
      queries.updateRoom(db, tinyRoomId, { queenWorkerId: tinyQueenId })

      // Small room: queen + 1 worker (stage 2 -- keeper + queen + worker = 3 members)
      const smallRoom = queries.createRoom(db, 'Small Room', 'Goal')
      smallRoomId = smallRoom.id
      const smallQueen = queries.createWorker(db, { name: 'Queen', systemPrompt: 'Queen prompt', roomId: smallRoomId })
      smallQueenId = smallQueen.id
      queries.updateRoom(db, smallRoomId, { queenWorkerId: smallQueenId })
      const w = queries.createWorker(db, { name: 'Worker', systemPrompt: 'W prompt', roomId: smallRoomId })
      smallWorkerId = w.id
    })

    it('sets keeper vote on voting decision', () => {
      const decision = queries.createDecision(
        db, tinyRoomId, tinyQueenId, 'Legacy keeper test', 'strategy', 'majority'
      )
      const result = keeperVote(db, decision.id, 'yes')
      expect(result.keeperVote).toBe('yes')
      // Still voting -- workers haven't voted yet
      expect(result.status).toBe('voting')
    })

    it('throws on already resolved decision', () => {
      const decision = announce(db, {
        roomId: tinyRoomId, proposerId: tinyQueenId,
        proposal: 'Already resolved', decisionType: 'low_impact'
      })
      // low_impact is auto-approved
      expect(decision.status).toBe('approved')
      expect(() => keeperVote(db, decision.id, 'yes')).toThrow('is not open for voting')
    })
  })
})

describe('getRoomVoters', () => {
  it('returns all workers in the room', () => {
    const voters = getRoomVoters(db, roomId)
    expect(voters).toHaveLength(3)
    expect(voters.map(v => v.name).sort()).toEqual(['Queen', 'Worker 1', 'Worker 2'])
  })

  it('excludes workers from other rooms', () => {
    queries.createWorker(db, { name: 'Outside', systemPrompt: 'Not in room' })
    const voters = getRoomVoters(db, roomId)
    expect(voters).toHaveLength(3)
  })
})
