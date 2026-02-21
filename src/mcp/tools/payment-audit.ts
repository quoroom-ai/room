import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'
import { propose } from '../../shared/quorum'

export interface PaymentAuditResult {
  decisionId: number | null
  skippedReason: string | null
}

export function recordPaymentAudit(
  db: Database.Database,
  roomId: number,
  proposalText: string
): PaymentAuditResult {
  try {
    const approved = queries.listDecisions(db, roomId, 'approved')
      .find(d => d.proposal === proposalText)
    if (approved) {
      return { decisionId: approved.id, skippedReason: null }
    }

    const pending = queries.listDecisions(db, roomId, 'voting')
      .find(d => d.proposal === proposalText)
    if (pending) {
      return { decisionId: pending.id, skippedReason: null }
    }

    const decision = propose(db, {
      roomId,
      proposerId: null,
      proposal: proposalText,
      decisionType: 'low_impact'
    })

    return { decisionId: decision.id, skippedReason: null }
  } catch (e) {
    return {
      decisionId: null,
      skippedReason: (e as Error).message
    }
  }
}

export function formatPaymentAuditSuffix(audit: PaymentAuditResult): string {
  if (audit.decisionId != null) {
    return ` Quorum audit proposal #${audit.decisionId} logged.`
  }
  if (audit.skippedReason) {
    const reason = audit.skippedReason.trim().replace(/\.+$/, '')
    return ` Quorum audit skipped: ${reason}.`
  }
  return ''
}
