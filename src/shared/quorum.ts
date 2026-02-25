import type Database from 'better-sqlite3'
import type { QuorumDecision, QuorumVote, DecisionType, DecisionStatus, VoteValue, Worker } from './types'
import * as queries from './db-queries'

export interface ProposeOptions {
  roomId: number
  proposerId: number | null
  proposal: string
  decisionType: DecisionType
}

export function propose(db: Database.Database, options: ProposeOptions): QuorumDecision {
  const room = queries.getRoom(db, options.roomId)
  if (!room) throw new Error(`Room ${options.roomId} not found`)

  const { threshold, timeoutMinutes, autoApprove, minVoters, sealedBallot } = room.config

  // Auto-approve if decision type is in the autoApprove list
  if (autoApprove.includes(options.decisionType)) {
    const decision = queries.createDecision(
      db, options.roomId, options.proposerId, options.proposal,
      options.decisionType, threshold
    )
    queries.resolveDecision(db, decision.id, 'approved', 'Auto-approved')
    queries.logRoomActivity(db, options.roomId, 'decision',
      `Auto-approved: ${options.proposal}`, undefined, options.proposerId ?? undefined)
    return queries.getDecision(db, decision.id)!
  }

  // Calculate timeout
  const timeoutAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString()

  const decision = queries.createDecision(
    db, options.roomId, options.proposerId, options.proposal,
    options.decisionType, threshold, timeoutAt, minVoters, sealedBallot
  )

  queries.logRoomActivity(db, options.roomId, 'decision',
    `Proposal: ${options.proposal}`, undefined, options.proposerId ?? undefined)

  return decision
}

export function vote(
  db: Database.Database, decisionId: number, workerId: number,
  voteValue: VoteValue, reasoning?: string
): QuorumVote {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)
  if (decision.status !== 'voting') {
    throw new Error(`Decision ${decisionId} is not open for voting (status: ${decision.status})`)
  }

  const qv = queries.castVote(db, decisionId, workerId, voteValue, reasoning)

  // Track participation for voter health
  queries.incrementVotesCast(db, workerId)

  // Auto-tally when all workers have voted (keeper vote is optional)
  const voters = getRoomVoters(db, decision.roomId)
  const votes = queries.getVotes(db, decisionId)

  if (votes.length >= voters.length) {
    tally(db, decisionId)
  }

  return qv
}

export function keeperVote(
  db: Database.Database, decisionId: number, voteValue: VoteValue
): QuorumDecision {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)
  if (decision.status !== 'voting') {
    throw new Error(`Decision ${decisionId} is not open for voting (status: ${decision.status})`)
  }

  queries.setKeeperVote(db, decisionId, voteValue)

  // Check if all voters have voted (workers + keeper)
  const voters = getRoomVoters(db, decision.roomId)
  const votes = queries.getVotes(db, decisionId)

  if (votes.length >= voters.length) {
    tally(db, decisionId)
  }

  return queries.getDecision(db, decisionId)!
}

export function tally(db: Database.Database, decisionId: number): DecisionStatus {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)

  const room = queries.getRoom(db, decision.roomId)
  const votes = queries.getVotes(db, decisionId)
  const voters = getRoomVoters(db, decision.roomId)

  // Quorum minimum check: reject if not enough non-abstain votes
  // Count both worker votes and keeper vote toward the minimum
  if (decision.minVoters > 0) {
    let nonAbstainVotes = votes.filter(v => v.vote !== 'abstain').length
    if (decision.keeperVote && decision.keeperVote !== 'abstain') nonAbstainVotes++
    if (nonAbstainVotes < decision.minVoters) {
      const result = `Quorum not met: ${nonAbstainVotes} of ${decision.minVoters} minimum non-abstain votes`
      queries.resolveDecision(db, decisionId, 'rejected', result)
      queries.logRoomActivity(db, decision.roomId, 'decision',
        `Decision rejected (quorum): ${decision.proposal} (${result})`)
      creditMissedVotes(db, votes, voters, room)
      return 'rejected'
    }
  }

  // Keeper and workers always count as one vote each.
  const queenWorkerId = room?.queenWorkerId ?? null
  const tieBreakerMode = room?.config.tieBreaker ?? 'queen'

  let yesWeight = 0
  let noWeight = 0
  let abstainCount = 0

  // Count worker votes
  for (const v of votes) {
    if (v.vote === 'yes') yesWeight += 1
    else if (v.vote === 'no') noWeight += 1
    else abstainCount++
  }

  // Count keeper vote
  const kv = decision.keeperVote
  if (kv && kv !== 'abstain') {
    if (kv === 'yes') yesWeight += 1
    else if (kv === 'no') noWeight += 1
  } else if (kv === 'abstain') {
    abstainCount++
  }

  const activeWeight = yesWeight + noWeight

  let status: DecisionStatus
  const threshold = decision.threshold

  if (activeWeight === 0) {
    // All abstained — no decision
    status = 'rejected'
  } else if (threshold === 'unanimous') {
    status = noWeight === 0 && yesWeight > 0 ? 'approved' : 'rejected'
  } else if (threshold === 'supermajority') {
    status = yesWeight >= activeWeight * 2 / 3 ? 'approved' : 'rejected'
  } else {
    // majority (default)
    if (yesWeight > activeWeight / 2) {
      status = 'approved'
    } else if (noWeight > activeWeight / 2) {
      status = 'rejected'
    } else {
      // Exact tie — apply tie-breaker
      if (tieBreakerMode === 'queen' && queenWorkerId !== null) {
        const queenVote = votes.find(v => v.workerId === queenWorkerId)
        status = queenVote?.vote === 'yes' ? 'approved' : 'rejected'
      } else {
        status = 'rejected'
      }
    }
  }

  const result = `Yes: ${yesWeight}, No: ${noWeight}, Abstain: ${abstainCount}`
  queries.resolveDecision(db, decisionId, status, result)

  queries.logRoomActivity(db, decision.roomId, 'decision',
    `Decision ${status}: ${decision.proposal} (${result})`)

  creditMissedVotes(db, votes, voters, room)

  return status
}

/** Track missed votes for workers who didn't participate (only when voterHealth is enabled) */
function creditMissedVotes(
  db: Database.Database,
  votes: QuorumVote[],
  voters: Worker[],
  room: { config: { voterHealth: boolean } } | null
): void {
  if (!room?.config.voterHealth) return

  const votedWorkerIds = new Set(votes.map(v => v.workerId))
  for (const voter of voters) {
    if (!votedWorkerIds.has(voter.id)) {
      queries.incrementVotesMissed(db, voter.id)
    }
  }
}

export function checkExpiredDecisions(db: Database.Database): number {
  const expired = queries.getExpiredDecisions(db)
  for (const d of expired) {
    tally(db, d.id)
  }
  return expired.length
}

export function getRoomVoters(db: Database.Database, roomId: number): Worker[] {
  return queries.listRoomWorkers(db, roomId)
}

/** Get voters above the health threshold (for display/MCP tool only, not for auto-tally) */
export function getEligibleVoters(db: Database.Database, roomId: number): Worker[] {
  const room = queries.getRoom(db, roomId)
  if (!room?.config.voterHealth) {
    return getRoomVoters(db, roomId)
  }
  const threshold = room.config.voterHealthThreshold
  const health = queries.getVoterHealth(db, roomId, threshold)
  const healthyIds = new Set(health.filter(h => h.isHealthy).map(h => h.workerId))
  return getRoomVoters(db, roomId).filter(w => healthyIds.has(w.id))
}
