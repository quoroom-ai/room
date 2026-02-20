import type Database from 'better-sqlite3'
import type { SelfModAuditEntry } from './types'
import * as queries from './db-queries'

const lastModTime = new Map<number, number>()
const MOD_RATE_LIMIT_MS = 60_000

const FORBIDDEN_PATTERNS = [
  /private.?key/i,
  /wallet.*encrypted/i,
  /credential.*value/i,
  /\.env$/,
  /self[-_]mod\.ts$/,
]

export function canModify(workerId: number, filePath: string): { allowed: boolean; reason?: string } {
  // Rate limit check
  const lastTime = lastModTime.get(workerId)
  if (lastTime && Date.now() - lastTime < MOD_RATE_LIMIT_MS) {
    const waitSec = Math.ceil((MOD_RATE_LIMIT_MS - (Date.now() - lastTime)) / 1000)
    return { allowed: false, reason: `Rate limited. Wait ${waitSec}s before next modification.` }
  }

  // Forbidden pattern check
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(filePath)) {
      return { allowed: false, reason: `Forbidden path pattern: ${pattern.source}` }
    }
  }

  return { allowed: true }
}

export function performModification(
  db: Database.Database, roomId: number | null, workerId: number,
  filePath: string, oldHash: string | null, newHash: string | null,
  reason: string, reversible: boolean = true
): SelfModAuditEntry {
  const check = canModify(workerId, filePath)
  if (!check.allowed) throw new Error(check.reason)

  const entry = queries.logSelfMod(db, roomId, workerId, filePath, oldHash, newHash, reason, reversible)
  lastModTime.set(workerId, Date.now())

  if (roomId != null) {
    queries.logRoomActivity(db, roomId, 'system',
      `Self-mod: ${reason} (${filePath})`, undefined, workerId)
  }

  return entry
}

export function revertModification(db: Database.Database, auditId: number): void {
  const entry = queries.getSelfModHistory(db, 0, 1000)
    .find(e => e.id === auditId)
  if (!entry) {
    // Try fetching from all rooms
    const row = db.prepare('SELECT * FROM self_mod_audit WHERE id = ?').get(auditId) as Record<string, unknown> | undefined
    if (!row) throw new Error(`Audit entry ${auditId} not found`)
    if ((row.reversible as number) !== 1) throw new Error('Modification is not reversible')
    if ((row.reverted as number) === 1) throw new Error('Modification already reverted')
  } else {
    if (!entry.reversible) throw new Error('Modification is not reversible')
    if (entry.reverted) throw new Error('Modification already reverted')
  }
  queries.markReverted(db, auditId)
}

export function getModificationHistory(db: Database.Database, roomId: number, limit: number = 50): SelfModAuditEntry[] {
  return queries.getSelfModHistory(db, roomId, limit)
}

// Reset rate limit (for testing)
export function _resetRateLimit(): void {
  lastModTime.clear()
}
