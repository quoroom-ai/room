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

  const { threshold, timeoutMinutes, autoApprove } = room.config

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
    options.decisionType, threshold, timeoutAt
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

  // Check if all voters have voted
  const voters = getRoomVoters(db, decision.roomId)
  const votes = queries.getVotes(db, decisionId)

  if (votes.length >= voters.length) {
    tally(db, decisionId)
  }

  return qv
}

export function tally(db: Database.Database, decisionId: number): DecisionStatus {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)

  const votes = queries.getVotes(db, decisionId)
  const yesCount = votes.filter(v => v.vote === 'yes').length
  const noCount = votes.filter(v => v.vote === 'no').length
  const abstainCount = votes.filter(v => v.vote === 'abstain').length
  const activeVoters = votes.length - abstainCount

  let status: DecisionStatus
  const threshold = decision.threshold

  if (activeVoters === 0) {
    // All abstained — no decision
    status = 'rejected'
  } else if (threshold === 'unanimous') {
    status = noCount === 0 && yesCount > 0 ? 'approved' : 'rejected'
  } else if (threshold === 'supermajority') {
    status = yesCount >= Math.ceil(activeVoters * 2 / 3) ? 'approved' : 'rejected'
  } else {
    // majority (default)
    status = yesCount > activeVoters / 2 ? 'approved' : 'rejected'
  }

  const result = `Yes: ${yesCount}, No: ${noCount}, Abstain: ${abstainCount}`
  queries.resolveDecision(db, decisionId, status, result)

  queries.logRoomActivity(db, decision.roomId, 'decision',
    `Decision ${status}: ${decision.proposal} (${result})`)

  return status
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
