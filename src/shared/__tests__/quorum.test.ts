import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { propose, vote, keeperVote, tally, checkExpiredDecisions, getRoomVoters, getEligibleVoters } from '../quorum'

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

describe('graduated autonomy (keeper voting)', () => {
  // Stage 1: keeper + queen only (1 worker = queen)
  let tinyRoomId: number
  let tinyQueenId: number

  // Stage 2: keeper + queen + worker (2 workers)
  let smallRoomId: number
  let smallQueenId: number
  let smallWorkerId: number

  beforeEach(() => {
    // Tiny room: just the queen (stage 1 — keeper + queen = 2 members)
    const tinyRoom = queries.createRoom(db, 'Tiny Room', 'Goal')
    tinyRoomId = tinyRoom.id
    const tinyQueen = queries.createWorker(db, { name: 'Queen', systemPrompt: 'Queen prompt', roomId: tinyRoomId })
    tinyQueenId = tinyQueen.id
    queries.updateRoom(db, tinyRoomId, { queenWorkerId: tinyQueenId })

    // Small room: queen + 1 worker (stage 2 — keeper + queen + worker = 3 members)
    const smallRoom = queries.createRoom(db, 'Small Room', 'Goal')
    smallRoomId = smallRoom.id
    const smallQueen = queries.createWorker(db, { name: 'Queen', systemPrompt: 'Queen prompt', roomId: smallRoomId })
    smallQueenId = smallQueen.id
    queries.updateRoom(db, smallRoomId, { queenWorkerId: smallQueenId })
    const w = queries.createWorker(db, { name: 'Worker', systemPrompt: 'W prompt', roomId: smallRoomId })
    smallWorkerId = w.id
  })

  it('stage 1: keeper yes + queen no → rejected (queen tie-breaker)', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Queen wins tie', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'yes')
    vote(db, decision.id, tinyQueenId, 'no')
    const resolved = queries.getDecision(db, decision.id)!
    // 1-1 tie → tieBreaker: 'queen', queen voted no → rejected
    expect(resolved.status).toBe('rejected')
  })

  it('stage 1: keeper no + queen yes → approved (queen tie-breaker)', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Queen approves', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'no')
    vote(db, decision.id, tinyQueenId, 'yes')
    const resolved = queries.getDecision(db, decision.id)!
    // 1-1 tie → tieBreaker: 'queen', queen voted yes → approved
    expect(resolved.status).toBe('approved')
  })

  it('stage 2: keeper no + queen yes + worker yes → approved (majority)', () => {
    const decision = propose(db, {
      roomId: smallRoomId, proposerId: smallQueenId,
      proposal: 'Collective wins', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'no')
    vote(db, decision.id, smallQueenId, 'yes')
    vote(db, decision.id, smallWorkerId, 'yes')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })

  it('stage 2: keeper yes + queen no + worker no → rejected (majority)', () => {
    const decision = propose(db, {
      roomId: smallRoomId, proposerId: smallQueenId,
      proposal: 'Keeper outvoted', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'yes')
    vote(db, decision.id, smallQueenId, 'no')
    vote(db, decision.id, smallWorkerId, 'no')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('rejected')
  })

  it('auto-tallies when all workers voted (keeper vote optional)', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Auto-tally test', decisionType: 'strategy'
    })
    // Queen is the only worker — voting triggers auto-tally even without keeper
    vote(db, decision.id, tinyQueenId, 'yes')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })

  it('keeper vote before workers triggers tally when all workers vote', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Keeper first', decisionType: 'strategy'
    })
    // Keeper votes first — no auto-tally yet (queen hasn't voted)
    keeperVote(db, decision.id, 'no')
    const still = queries.getDecision(db, decision.id)!
    expect(still.status).toBe('voting')

    // Queen votes — auto-tally fires, 1-1 tie → queen tie-breaker → approved
    vote(db, decision.id, tinyQueenId, 'yes')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })

  it('keeper abstain excluded from active weight', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Keeper abstains', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'abstain')
    vote(db, decision.id, tinyQueenId, 'yes')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })

  it('keeper always has equal weight (tie-breaker decides)', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Equal weight', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'yes')
    vote(db, decision.id, tinyQueenId, 'no')
    // 1 yes vs 1 no — tie, tieBreaker: 'queen', queen voted no → rejected
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('rejected')
  })

  it('tieBreaker queen breaks ties in 3-member room', () => {
    const decision = propose(db, {
      roomId: smallRoomId, proposerId: smallQueenId,
      proposal: 'Tiebreaker test', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'no')
    vote(db, decision.id, smallQueenId, 'yes')
    vote(db, decision.id, smallWorkerId, 'abstain')
    // 1 yes (queen) vs 1 no (keeper) — tie, tieBreaker: queen voted yes → approved
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
  })

  it('tieBreaker none → ties reject', () => {
    const config = {
      ...queries.getRoom(db, smallRoomId)!.config,
      tieBreaker: 'none' as const
    }
    queries.updateRoom(db, smallRoomId, { config })

    const decision = propose(db, {
      roomId: smallRoomId, proposerId: smallQueenId,
      proposal: 'No tiebreaker', decisionType: 'strategy'
    })
    keeperVote(db, decision.id, 'no')
    vote(db, decision.id, smallQueenId, 'yes')
    vote(db, decision.id, smallWorkerId, 'abstain')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('rejected')
  })

  it('keeperVote throws on already resolved decision', () => {
    const decision = propose(db, {
      roomId: tinyRoomId, proposerId: tinyQueenId,
      proposal: 'Already resolved', decisionType: 'low_impact'
    })
    // low_impact is auto-approved
    expect(decision.status).toBe('approved')
    expect(() => keeperVote(db, decision.id, 'yes')).toThrow('is not open for voting')
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

describe('quorum minimums (minVoters)', () => {
  it('rejects when non-abstain votes < minVoters', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 3 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Min test', decisionType: 'strategy' })
    expect(decision.minVoters).toBe(3)

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    // Only 2 non-abstain, need 3
    const status = tally(db, decision.id)
    expect(status).toBe('rejected')
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.result).toContain('Quorum not met')
  })

  it('approves when non-abstain votes >= minVoters', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 2 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Min pass', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    const status = tally(db, decision.id)
    expect(status).toBe('approved')
  })

  it('minVoters=0 leaves behavior unchanged', () => {
    // Default config has minVoters=0
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Default min', decisionType: 'strategy' })
    expect(decision.minVoters).toBe(0)
    vote(db, decision.id, queenId, 'yes')
    const status = tally(db, decision.id)
    expect(status).toBe('approved')
  })

  it('snapshots minVoters at propose time', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 1 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Snapshot', decisionType: 'strategy' })
    expect(decision.minVoters).toBe(1)

    // Raise config to 3 after proposal
    queries.updateRoom(db, roomId, { config: { ...config, minVoters: 3 } })

    vote(db, decision.id, queenId, 'yes')
    // Only 1 non-abstain — but snapshotted minVoters is 1
    const status = tally(db, decision.id)
    expect(status).toBe('approved')
  })

  it('abstain votes do not count toward quorum minimum', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 2 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Abstain min', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'abstain')
    // 1 non-abstain, need 2
    const status = tally(db, decision.id)
    expect(status).toBe('rejected')
    expect(queries.getDecision(db, decision.id)!.result).toContain('Quorum not met')
  })

  it('keeper non-abstain vote counts toward minVoters', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 2 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Keeper quorum', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'abstain')
    keeperVote(db, decision.id, 'yes')
    // 1 worker non-abstain (queen) + 1 keeper non-abstain = 2 → meets minVoters=2
    // Without keeper counting, would be 1 < 2 → rejected
    const status = tally(db, decision.id)
    expect(status).toBe('approved')
  })

  it('keeper abstain vote does not count toward minVoters', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 2 }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Keeper abstain quorum', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'abstain')
    keeperVote(db, decision.id, 'abstain')
    // 1 worker non-abstain + 0 keeper (abstained) = 1 < minVoters=2
    const status = tally(db, decision.id)
    expect(status).toBe('rejected')
    expect(queries.getDecision(db, decision.id)!.result).toContain('Quorum not met')
  })

  it('expired decisions with unmet quorum are rejected', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, minVoters: 2 }
    queries.updateRoom(db, roomId, { config })

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

    const decision = queries.createDecision(db, roomId, queenId, 'Expire quorum', 'strategy', 'majority', localTimeStr, 2)
    queries.castVote(db, decision.id, queenId, 'yes')

    checkExpiredDecisions(db)
    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('rejected')
    expect(resolved.result).toContain('Quorum not met')
  })
})

describe('sealed ballot', () => {
  it('sealedBallot=true creates sealed decision', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, sealedBallot: true }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Secret vote', decisionType: 'strategy' })
    expect(decision.sealed).toBe(true)
  })

  it('sealedBallot=false creates non-sealed decision', () => {
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Open vote', decisionType: 'strategy' })
    expect(decision.sealed).toBe(false)
  })

  it('sealed decisions still tally correctly', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, sealedBallot: true }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Sealed tally', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    vote(db, decision.id, worker2Id, 'no')

    const resolved = queries.getDecision(db, decision.id)!
    expect(resolved.status).toBe('approved')
    expect(resolved.sealed).toBe(true)
  })

  it('votes stored normally at DB layer (redaction is API-level only)', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, sealedBallot: true }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Sealed storage', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes', 'my reason')
    const votes = queries.getVotes(db, decision.id)
    expect(votes[0].vote).toBe('yes')
    expect(votes[0].reasoning).toBe('my reason')
  })
})

describe('voter health tracking', () => {
  it('votes_cast increments after voting', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, voterHealth: true }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Health track', decisionType: 'strategy' })

    const before = queries.getWorker(db, queenId)!.votesCast
    vote(db, decision.id, queenId, 'yes')
    const after = queries.getWorker(db, queenId)!.votesCast
    expect(after).toBe(before + 1)
  })

  it('votes_missed increments for non-voters after tally when voterHealth=true', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, voterHealth: true }
    queries.updateRoom(db, roomId, { config })
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Missed vote', decisionType: 'strategy' })

    vote(db, decision.id, queenId, 'yes')
    tally(db, decision.id)

    expect(queries.getWorker(db, queenId)!.votesMissed).toBe(0)
    expect(queries.getWorker(db, worker1Id)!.votesMissed).toBe(1)
    expect(queries.getWorker(db, worker2Id)!.votesMissed).toBe(1)
  })

  it('votes_missed NOT incremented when voterHealth=false', () => {
    // Default config has voterHealth=false
    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'No health', decisionType: 'strategy' })
    vote(db, decision.id, queenId, 'yes')
    tally(db, decision.id)

    expect(queries.getWorker(db, worker1Id)!.votesMissed).toBe(0)
  })

  it('getVoterHealth returns correct participation rates', () => {
    queries.incrementVotesCast(db, queenId)
    queries.incrementVotesCast(db, queenId)
    queries.incrementVotesCast(db, worker1Id)
    queries.incrementVotesMissed(db, worker1Id)

    const health = queries.getVoterHealth(db, roomId, 0.5)
    const queenHealth = health.find(h => h.workerId === queenId)!
    const w1Health = health.find(h => h.workerId === worker1Id)!

    expect(queenHealth.participationRate).toBe(1.0)
    expect(queenHealth.isHealthy).toBe(true)
    expect(w1Health.participationRate).toBe(0.5) // 1/(1+1)
    expect(w1Health.isHealthy).toBe(true) // 0.5 >= 0.5
  })

  it('workers below threshold flagged as unhealthy', () => {
    queries.incrementVotesCast(db, worker1Id)
    queries.incrementVotesMissed(db, worker1Id)
    queries.incrementVotesMissed(db, worker1Id)
    // participationRate = 1/3 ≈ 0.33
    const health = queries.getVoterHealth(db, roomId, 0.5)
    const w1Health = health.find(h => h.workerId === worker1Id)!
    expect(w1Health.isHealthy).toBe(false)
  })

  it('getEligibleVoters excludes unhealthy workers when voterHealth=true', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, voterHealth: true, voterHealthThreshold: 0.5 }
    queries.updateRoom(db, roomId, { config })

    // Make worker2 unhealthy
    queries.incrementVotesMissed(db, worker2Id)
    queries.incrementVotesMissed(db, worker2Id)

    const eligible = getEligibleVoters(db, roomId)
    const eligibleIds = eligible.map(w => w.id)
    expect(eligibleIds).toContain(queenId)
    expect(eligibleIds).toContain(worker1Id)
    expect(eligibleIds).not.toContain(worker2Id)
  })

  it('auto-tally still uses all workers not just eligible', () => {
    const config = { ...queries.getRoom(db, roomId)!.config, voterHealth: true, voterHealthThreshold: 0.5 }
    queries.updateRoom(db, roomId, { config })
    queries.incrementVotesMissed(db, worker2Id)
    queries.incrementVotesMissed(db, worker2Id)

    const decision = propose(db, { roomId, proposerId: queenId, proposal: 'Health tally', decisionType: 'strategy' })
    vote(db, decision.id, queenId, 'yes')
    vote(db, decision.id, worker1Id, 'yes')
    // Still voting — all 3 workers must vote for auto-tally
    expect(queries.getDecision(db, decision.id)!.status).toBe('voting')

    vote(db, decision.id, worker2Id, 'yes')
    expect(queries.getDecision(db, decision.id)!.status).toBe('approved')
  })
})
