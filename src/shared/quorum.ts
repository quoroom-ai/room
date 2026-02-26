import type Database from 'better-sqlite3'
import type { QuorumDecision, DecisionType } from './types'
import * as queries from './db-queries'

export interface AnnounceOptions {
  roomId: number
  proposerId: number | null
  proposal: string
  decisionType: DecisionType
  delayMinutes?: number
}

/**
 * Queen announces a decision. It becomes effective after `delayMinutes` (default 10)
 * unless a worker objects before then.
 */
export function announce(db: Database.Database, options: AnnounceOptions): QuorumDecision {
  const room = queries.getRoom(db, options.roomId)
  if (!room) throw new Error(`Room ${options.roomId} not found`)

  const { autoApprove } = room.config

  // Auto-approve if decision type is in the autoApprove list
  if (autoApprove.includes(options.decisionType)) {
    const decision = queries.createDecision(
      db, options.roomId, options.proposerId, options.proposal,
      options.decisionType, 'majority'
    )
    queries.resolveDecision(db, decision.id, 'approved', 'Auto-approved')
    queries.logRoomActivity(db, options.roomId, 'decision',
      `Auto-approved: ${options.proposal}`, undefined, options.proposerId ?? undefined)
    return queries.getDecision(db, decision.id)!
  }

  const delayMs = (options.delayMinutes ?? 10) * 60 * 1000
  const effectiveAt = new Date(Date.now() + delayMs).toISOString()

  const decision = queries.createAnnouncement(
    db, options.roomId, options.proposerId, options.proposal,
    options.decisionType, effectiveAt
  )

  queries.logRoomActivity(db, options.roomId, 'decision',
    `Announced: ${options.proposal} (effective in ${options.delayMinutes ?? 10} min)`,
    undefined, options.proposerId ?? undefined)

  return decision
}

/**
 * Worker objects to an announced decision. Sets status to 'objected'.
 */
export function object(
  db: Database.Database, decisionId: number, workerId: number, reason: string
): QuorumDecision {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)
  if (decision.status !== 'announced') {
    throw new Error(`Decision ${decisionId} is not open for objection (status: ${decision.status})`)
  }

  queries.resolveDecision(db, decisionId, 'objected', `Objected by worker #${workerId}: ${reason}`)
  queries.logRoomActivity(db, decision.roomId, 'decision',
    `Objected: ${decision.proposal} — ${reason}`, undefined, workerId)

  return queries.getDecision(db, decisionId)!
}

/**
 * Check for announced decisions past their effective_at time and auto-approve them.
 * Also handles expired voting decisions (legacy).
 */
export function checkExpiredDecisions(db: Database.Database): number {
  let count = 0

  // Auto-effective announcements
  const announced = queries.getAnnouncedDecisions(db)
  for (const d of announced) {
    queries.resolveDecision(db, d.id, 'effective', 'No objections — auto-effective')
    queries.logRoomActivity(db, d.roomId, 'decision',
      `Effective: ${d.proposal} (no objections)`)
    count++
  }

  // Legacy: expired voting decisions
  const expired = queries.getExpiredDecisions(db)
  for (const d of expired) {
    queries.resolveDecision(db, d.id, 'expired', 'Voting period expired')
    queries.logRoomActivity(db, d.roomId, 'decision',
      `Expired: ${d.proposal}`)
    count++
  }

  return count
}

// Keep for backward compatibility with MCP tools
export { announce as propose }

export function vote(
  db: Database.Database, decisionId: number, workerId: number,
  voteValue: 'yes' | 'no' | 'abstain', reasoning?: string
) {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)
  if (decision.status !== 'voting') {
    throw new Error(`Decision ${decisionId} is not open for voting (status: ${decision.status})`)
  }
  return queries.castVote(db, decisionId, workerId, voteValue, reasoning)
}

export function keeperVote(
  db: Database.Database, decisionId: number, voteValue: 'yes' | 'no' | 'abstain'
): QuorumDecision {
  const decision = queries.getDecision(db, decisionId)
  if (!decision) throw new Error(`Decision ${decisionId} not found`)

  // Support both old voting and new announce model
  if (decision.status === 'announced') {
    if (voteValue === 'no') {
      queries.resolveDecision(db, decisionId, 'objected', 'Keeper objected')
    } else {
      queries.resolveDecision(db, decisionId, 'effective', 'Keeper approved')
    }
    return queries.getDecision(db, decisionId)!
  }

  if (decision.status !== 'voting') {
    throw new Error(`Decision ${decisionId} is not open for voting (status: ${decision.status})`)
  }
  queries.setKeeperVote(db, decisionId, voteValue)
  return queries.getDecision(db, decisionId)!
}

export function getRoomVoters(db: Database.Database, roomId: number) {
  return queries.listRoomWorkers(db, roomId)
}
