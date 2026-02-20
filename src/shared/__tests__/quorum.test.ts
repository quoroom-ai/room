import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { propose, vote, tally, checkExpiredDecisions, getRoomVoters } from '../quorum'

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

describe('propose', () => {
  it('creates a voting proposal', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Build a SaaS product',
      decisionType: 'strategy'
    })
    expect(decision.status).toBe('voting')
    expect(decision.proposal).toBe('Build a SaaS product')
    expect(decision.decisionType).toBe('strategy')
    expect(decision.timeoutAt).not.toBeNull()
  })

  it('auto-approves low_impact decisions', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Update a skill',
      decisionType: 'low_impact'
    })
    expect(decision.status).toBe('approved')
    expect(decision.result).toBe('Auto-approved')
  })

  it('throws for nonexistent room', () => {
    expect(() => propose(db, {
      roomId: 999, proposerId: queenId,
      proposal: 'Test', decisionType: 'strategy'
    })).toThrow('Room 999 not found')
  })

  it('logs activity on proposal', () => {
    propose(db, {
      roomId, proposerId: queenId,
      proposal: 'New direction',
      decisionType: 'strategy'
    })
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.length).toBeGreaterThan(0)
    expect(activity[0].eventType).toBe('decision')
  })
})

describe('vote', () => {
  it('casts a vote', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Test', decisionType: 'strategy'
    })
    const v = vote(db, decision.id, queenId, 'yes', 'Looks good')
    expect(v.vote).toBe('yes')
    expect(v.reasoning).toBe('Looks good')
  })

  it('throws on double vote', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    expect(() => vote(db, decision.id, queenId, 'no')).toThrow()
  })

  it('throws when decision is not voting', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Auto', decisionType: 'low_impact'
    })
    expect(() => vote(db, decision.id, queenId, 'yes'))
      .toThrow('is not open for voting')
  })

  it('auto-tallies when all voters have voted', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Vote test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    vote(db, decision.id, worker2Id, 'no')

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })
})

describe('tally', () => {
  it('approves with majority', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Majority test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    // worker2 hasn't voted yet — manual tally
    const status = tally(db, decision.id)
    expect(status).toBe('approved')
  })

  it('rejects without majority', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Reject test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'no')
    vote(db, decision.id, worker1Id, 'no')
    const status = tally(db, decision.id)
    expect(status).toBe('rejected')
  })

  it('handles unanimous threshold', () => {
    // Create room with unanimous config
    const config = { ...queries.getRoom(db, roomId)!.config, threshold: 'unanimous' as const }
    queries.updateRoom(db, roomId, { config })

    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Unanimous test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    vote(db, decision.id, worker2Id, 'no')

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('rejected')
  })

  it('handles supermajority threshold', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, threshold: 'supermajority' as const }
    queries.updateRoom(db, roomId, { config })

    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Super test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    vote(db, decision.id, worker2Id, 'no')

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved') // 2/3 >= 2/3
  })

  it('handles all abstain as rejected', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Abstain test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'abstain')
    vote(db, decision.id, worker1Id, 'abstain')
    const status = tally(db, decision.id)
    expect(status).toBe('rejected')
  })

  it('excludes abstain from active voter count', () => {
    const decision = propose(db, {
      roomId, proposerId: queenId,
      proposal: 'Abstain exclude test', decisionType: 'strategy'
    })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'abstain')
    vote(db, decision.id, worker2Id, 'no')

    const resolved = queries.getDecision(db, decision.id)!
    // activeVoters = 2 (yes + no), yesCount = 1. 1 > 2/2 = false → rejected
    expect(resolved.status).toBe('rejected')
  })
})

describe('checkExpiredDecisions', () => {
  it('tallies expired decisions', () => {
    // Use SQLite local time format (YYYY-MM-DD HH:MM:SS) to match datetime('now','localtime')
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
      db, roomId, queenId, 'Expired proposal', 'strategy', 'majority',
      localTimeStr
    )
    queries.castVote(db, decision.id, queenId, 'yes')

    const count = checkExpiredDecisions(db)
    expect(count).toBe(1)

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).not.toBe('voting')
  })

  it('returns 0 when no expired decisions', () => {
    expect(checkExpiredDecisions(db)).toBe(0)
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
