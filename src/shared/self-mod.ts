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

export function canModify(workerId: number | null, filePath: string): { allowed: boolean; reason?: string } {
  // Rate limit check
  if (workerId != null) {
    const lastTime = lastModTime.get(workerId)
    if (lastTime && Date.now() - lastTime < MOD_RATE_LIMIT_MS) {
      const waitSec = Math.ceil((MOD_RATE_LIMIT_MS - (Date.now() - lastTime)) / 1000)
      return { allowed: false, reason: `Rate limited. Wait ${waitSec}s before next modification.` }
    }
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
  db: Database.Database, roomId: number | null, workerId: number | null,
  filePath: string, oldHash: string | null, newHash: string | null,
  reason: string, reversible: boolean = true
): SelfModAuditEntry {
  const check = canModify(workerId, filePath)
  if (!check.allowed) throw new Error(check.reason)

  const entry = queries.logSelfMod(db, roomId, workerId, filePath, oldHash, newHash, reason, reversible)
  if (workerId != null) {
    lastModTime.set(workerId, Date.now())
  }

  if (roomId != null) {
    queries.logRoomActivity(db, roomId, 'system',
      `Self-mod: ${reason} (${filePath})`, undefined, workerId ?? undefined)
  }

  return entry
}

export function revertModification(db: Database.Database, auditId: number): void {
  const entry = queries.getSelfModEntry(db, auditId)
  if (!entry) throw new Error(`Audit entry ${auditId} not found`)
  if (!entry.reversible) throw new Error('Modification is not reversible')
  if (entry.reverted) throw new Error('Modification already reverted')

  const snapshot = queries.getSelfModSnapshot(db, auditId)
  const tx = db.transaction(() => {
    // True revert for skill content edits when snapshot data exists.
    if (snapshot?.targetType === 'skill' && snapshot.targetId != null) {
      if (snapshot.oldContent == null) throw new Error('Cannot revert skill modification without old content snapshot')
      const skill = queries.getSkill(db, snapshot.targetId)
      if (!skill) throw new Error(`Skill ${snapshot.targetId} not found`)
      queries.updateSkill(db, snapshot.targetId, {
        content: snapshot.oldContent,
        version: skill.version + 1
      })
    }
    queries.markReverted(db, auditId)
  })

  try {
    tx()
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error(String(err))
  }
}

export function getModificationHistory(db: Database.Database, roomId: number, limit: number = 50): SelfModAuditEntry[] {
  return queries.getSelfModHistory(db, roomId, limit)
}

// Reset rate limit (for testing)
export function _resetRateLimit(): void {
  lastModTime.clear()
}
