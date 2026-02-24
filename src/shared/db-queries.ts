import type Database from 'better-sqlite3'
import type { Entity, Observation, Relation, MemoryStats, Task, CreateTaskInput, TaskRun, Worker, CreateWorkerInput, TriggerType, TaskStatus, Watch, ConsoleLogEntry, Room, RoomConfig, RoomActivityEntry, ActivityEventType, QuorumDecision, DecisionType, DecisionStatus, QuorumVote, VoteValue, Goal, GoalStatus, GoalUpdate, Skill, SelfModAuditEntry, SelfModSnapshot, Escalation, EscalationStatus, ChatMessage, Credential, Wallet, WalletTransaction, WalletTransactionType, Station, StationStatus, StationProvider, StationTier, RoomMessage, RevenueSummary, WorkerCycle, CycleLogEntry } from './types'
import { DEFAULT_ROOM_CONFIG } from './constants'
import { encryptSecret, decryptSecret } from './secret-store'

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit == null) return fallback
  const n = Math.trunc(limit)
  if (n < 1) return fallback
  if (n > max) return max
  return n
}

// ─── Entities ───────────────────────────────────────────────

export function createEntity(db: Database.Database, name: string, type: string = 'fact', category?: string, roomId?: number): Entity {
  const result = db
    .prepare('INSERT INTO entities (name, type, category, room_id) VALUES (?, ?, ?, ?)')
    .run(name, type, category ?? null, roomId ?? null)
  return getEntity(db, result.lastInsertRowid as number)!
}

export function getEntity(db: Database.Database, id: number): Entity | null {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Entity | undefined
  return row ?? null
}

export function listEntities(db: Database.Database, roomId?: number, category?: string): Entity[] {
  if (roomId != null && category) {
    return db
      .prepare('SELECT * FROM entities WHERE room_id = ? AND category = ? ORDER BY updated_at DESC')
      .all(roomId, category) as Entity[]
  }
  if (roomId != null) {
    return db
      .prepare('SELECT * FROM entities WHERE room_id = ? ORDER BY updated_at DESC')
      .all(roomId) as Entity[]
  }
  if (category) {
    return db
      .prepare('SELECT * FROM entities WHERE category = ? ORDER BY updated_at DESC')
      .all(category) as Entity[]
  }
  return db.prepare('SELECT * FROM entities ORDER BY updated_at DESC').all() as Entity[]
}

export function updateEntity(db: Database.Database, id: number, updates: { name?: string; type?: string; category?: string }): void {
  const fields: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type) }
  if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category) }
  if (fields.length === 0) return

  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE entities SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteEntity(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM entities WHERE id = ?').run(id)
}

export function searchEntities(db: Database.Database, query: string): Entity[] {
  try {
    const ftsResults = db
      .prepare(
        `SELECT e.* FROM entities e
         INNER JOIN memory_fts fts ON e.id = fts.rowid
         WHERE memory_fts MATCH ?
         ORDER BY rank`
      )
      .all(query) as Entity[]

    if (ftsResults.length > 0) return ftsResults
  } catch {
    // FTS parse error (special characters in query) — fall through to LIKE
  }

  // Escape LIKE wildcards to prevent wildcard injection
  const escaped = query.replace(/[%_]/g, '\\$&')
  return db
    .prepare("SELECT * FROM entities WHERE name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' ORDER BY updated_at DESC")
    .all(`%${escaped}%`, `%${escaped}%`) as Entity[]
}

// ─── Observations ───────────────────────────────────────────

export function addObservation(db: Database.Database, entityId: number, content: string, source: string = 'claude'): Observation {
  const result = db
    .prepare('INSERT INTO observations (entity_id, content, source) VALUES (?, ?, ?)')
    .run(entityId, content, source)
  db.prepare("UPDATE entities SET embedded_at = NULL, updated_at = datetime('now','localtime') WHERE id = ?").run(entityId)
  return getObservation(db, result.lastInsertRowid as number)!
}

export function getObservation(db: Database.Database, id: number): Observation | null {
  const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Observation | undefined
  return row ?? null
}

export function getObservations(db: Database.Database, entityId: number): Observation[] {
  return db
    .prepare('SELECT * FROM observations WHERE entity_id = ? ORDER BY id DESC')
    .all(entityId) as Observation[]
}

export function deleteObservation(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM observations WHERE id = ?').run(id)
}

// ─── Relations ──────────────────────────────────────────────

export function addRelation(db: Database.Database, fromEntity: number, toEntity: number, relationType: string): Relation {
  const result = db
    .prepare('INSERT INTO relations (from_entity, to_entity, relation_type) VALUES (?, ?, ?)')
    .run(fromEntity, toEntity, relationType)
  return getRelation(db, result.lastInsertRowid as number)!
}

export function getRelation(db: Database.Database, id: number): Relation | null {
  const row = db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Relation | undefined
  return row ?? null
}

export function getRelations(db: Database.Database, entityId: number): Relation[] {
  return db
    .prepare('SELECT * FROM relations WHERE from_entity = ? OR to_entity = ? ORDER BY created_at DESC')
    .all(entityId, entityId) as Relation[]
}

export function deleteRelation(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM relations WHERE id = ?').run(id)
}

// ─── Stats ──────────────────────────────────────────────────

export function getMemoryStats(db: Database.Database): MemoryStats {
  const entities = db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number }
  const observations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }
  const relations = db.prepare('SELECT COUNT(*) as count FROM relations').get() as { count: number }
  return {
    entityCount: entities.count,
    observationCount: observations.count,
    relationCount: relations.count
  }
}

// ─── Workers ────────────────────────────────────────────────

export function createWorker(db: Database.Database, input: CreateWorkerInput): Worker {
  if (input.isDefault) {
    db.prepare('UPDATE workers SET is_default = 0 WHERE is_default = 1').run()
  }
  const result = db
    .prepare(
      `INSERT INTO workers (name, role, system_prompt, description, model, is_default, cycle_gap_ms, max_turns, room_id, agent_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.name, input.role ?? null, input.systemPrompt, input.description ?? null, input.model ?? null, input.isDefault ? 1 : 0, input.cycleGapMs ?? null, input.maxTurns ?? null, input.roomId ?? null, input.agentState ?? 'idle')
  return getWorker(db, result.lastInsertRowid as number)!
}

export function getWorker(db: Database.Database, id: number): Worker | null {
  const row = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapWorkerRow(row) : null
}

export function listWorkers(db: Database.Database): Worker[] {
  const rows = db.prepare('SELECT * FROM workers ORDER BY is_default DESC, name ASC').all()
  return (rows as Record<string, unknown>[]).map(mapWorkerRow)
}

export function getWorkerCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM workers').get() as { cnt: number }
  return row.cnt
}

export function updateWorker(db: Database.Database, id: number, updates: Partial<{
  name: string; role: string | null; systemPrompt: string; description: string; model: string; isDefault: boolean; cycleGapMs: number | null; maxTurns: number | null; roomId: number | null; agentState: string
}>): void {
  if (updates.isDefault === true) {
    db.prepare('UPDATE workers SET is_default = 0 WHERE is_default = 1').run()
  }
  const fieldMap: Record<string, string> = {
    name: 'name', role: 'role', systemPrompt: 'system_prompt', description: 'description',
    model: 'model', isDefault: 'is_default', cycleGapMs: 'cycle_gap_ms', maxTurns: 'max_turns',
    roomId: 'room_id', agentState: 'agent_state'
  }
  const fields: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(updates)) {
    const dbField = fieldMap[key]
    if (dbField) {
      fields.push(`${dbField} = ?`)
      values.push(key === 'isDefault' ? (value ? 1 : 0) : value)
    }
  }
  if (fields.length === 0) return

  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE workers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteWorker(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM workers WHERE id = ?').run(id)
}

export function getDefaultWorker(db: Database.Database): Worker | null {
  const row = db.prepare('SELECT * FROM workers WHERE is_default = 1 LIMIT 1').get() as Record<string, unknown> | undefined
  return row ? mapWorkerRow(row) : null
}

export function refreshWorkerTaskCount(db: Database.Database, workerId: number): void {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE worker_id = ?').get(workerId) as { count: number }
  db.prepare('UPDATE workers SET task_count = ? WHERE id = ?').run(row.count, workerId)
}

function mapWorkerRow(row: Record<string, unknown>): Worker {
  return {
    id: row.id as number,
    name: row.name as string,
    role: (row.role as string | null) ?? null,
    systemPrompt: row.system_prompt as string,
    description: row.description as string | null,
    model: row.model as string | null,
    isDefault: (row.is_default as number) === 1,
    taskCount: (row.task_count as number) ?? 0,
    cycleGapMs: (row.cycle_gap_ms as number | null) ?? null,
    maxTurns: (row.max_turns as number | null) ?? null,
    roomId: (row.room_id as number | null) ?? null,
    agentState: ((row.agent_state as string) ?? 'idle') as Worker['agentState'],
    votesCast: (row.votes_cast as number) ?? 0,
    votesMissed: (row.votes_missed as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

// ─── Tasks ──────────────────────────────────────────────────

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const result = db
    .prepare(
      `INSERT INTO tasks (name, description, prompt, cron_expression, trigger_type, trigger_config, webhook_token, scheduled_at, executor, max_runs, worker_id, session_continuity, timeout_minutes, max_turns, allowed_tools, disallowed_tools, room_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name,
      input.description ?? null,
      input.prompt,
      input.cronExpression ?? null,
      input.triggerType ?? 'cron',
      input.triggerConfig ?? null,
      input.webhookToken ?? null,
      input.scheduledAt ?? null,
      input.executor ?? 'claude_code',
      input.maxRuns ?? null,
      input.workerId ?? null,
      input.sessionContinuity ? 1 : 0,
      input.timeoutMinutes ?? null,
      input.maxTurns ?? null,
      input.allowedTools ?? null,
      input.disallowedTools ?? null,
      input.roomId ?? null
    )
  const task = getTask(db, result.lastInsertRowid as number)!
  if (input.workerId) refreshWorkerTaskCount(db, input.workerId)
  return task
}

export function getTask(db: Database.Database, id: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapTaskRow(row) : null
}

export function getTaskByWebhookToken(db: Database.Database, token: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE webhook_token = ?').get(token) as Record<string, unknown> | undefined
  return row ? mapTaskRow(row) : null
}

export function listTasks(db: Database.Database, roomId?: number, status?: string): Task[] {
  if (roomId != null && status) {
    const rows = db.prepare('SELECT * FROM tasks WHERE room_id = ? AND status = ? ORDER BY created_at DESC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapTaskRow)
  }
  if (roomId != null) {
    const rows = db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
    return (rows as Record<string, unknown>[]).map(mapTaskRow)
  }
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(mapTaskRow)
}

export function updateTask(db: Database.Database, id: number, updates: Partial<{
  name: string; description: string; prompt: string; cronExpression: string
  triggerType: TriggerType; triggerConfig: string; webhookToken: string | null; scheduledAt: string; executor: string
  status: TaskStatus; lastRun: string; lastResult: string; errorCount: number
  maxRuns: number; runCount: number; memoryEntityId: number
  workerId: number | null; sessionContinuity: boolean; sessionId: string | null
  timeoutMinutes: number | null; maxTurns: number | null
  allowedTools: string | null; disallowedTools: string | null
  learnedContext: string | null
}>): void {
  const fieldMap: Record<string, string> = {
    name: 'name', description: 'description', prompt: 'prompt',
    cronExpression: 'cron_expression', triggerType: 'trigger_type',
    triggerConfig: 'trigger_config', webhookToken: 'webhook_token', scheduledAt: 'scheduled_at',
    executor: 'executor', status: 'status',
    lastRun: 'last_run', lastResult: 'last_result', errorCount: 'error_count',
    maxRuns: 'max_runs', runCount: 'run_count', memoryEntityId: 'memory_entity_id',
    workerId: 'worker_id', sessionContinuity: 'session_continuity', sessionId: 'session_id',
    timeoutMinutes: 'timeout_minutes', maxTurns: 'max_turns',
    allowedTools: 'allowed_tools', disallowedTools: 'disallowed_tools',
    learnedContext: 'learned_context'
  }

  const fields: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(updates)) {
    const dbField = fieldMap[key]
    if (dbField) {
      fields.push(`${dbField} = ?`)
      values.push(key === 'sessionContinuity' ? (value ? 1 : 0) : value)
    }
  }
  if (fields.length === 0) return

  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteTask(db: Database.Database, id: number): void {
  const task = getTask(db, id)
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  if (task?.workerId) refreshWorkerTaskCount(db, task.workerId)
}

export function pauseTask(db: Database.Database, id: number): void {
  updateTask(db, id, { status: 'paused' })
}

export function resumeTask(db: Database.Database, id: number): void {
  updateTask(db, id, { status: 'active' })
}

// ─── Watches ────────────────────────────────────────────────

export function createWatch(db: Database.Database, path: string, description?: string, actionPrompt?: string, roomId?: number): Watch {
  const result = db
    .prepare('INSERT INTO watches (path, description, action_prompt, room_id) VALUES (?, ?, ?, ?)')
    .run(path, description ?? null, actionPrompt ?? null, roomId ?? null)
  return getWatch(db, result.lastInsertRowid as number)!
}

export function getWatch(db: Database.Database, id: number): Watch | null {
  const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapWatchRow(row) : null
}

export function listWatches(db: Database.Database, roomId?: number, status?: string): Watch[] {
  if (roomId != null && status) {
    const rows = db.prepare('SELECT * FROM watches WHERE room_id = ? AND status = ? ORDER BY created_at DESC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapWatchRow)
  }
  if (roomId != null) {
    const rows = db.prepare('SELECT * FROM watches WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
    return (rows as Record<string, unknown>[]).map(mapWatchRow)
  }
  const rows = status
    ? db.prepare('SELECT * FROM watches WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(mapWatchRow)
}

export function getWatchCount(db: Database.Database, status?: string): number {
  const row = status
    ? db.prepare('SELECT count(*) as cnt FROM watches WHERE status = ?').get(status) as { cnt: number }
    : db.prepare('SELECT count(*) as cnt FROM watches').get() as { cnt: number }
  return row.cnt
}

export function deleteWatch(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM watches WHERE id = ?').run(id)
}

export function pauseWatch(db: Database.Database, id: number): void {
  db.prepare("UPDATE watches SET status = 'paused' WHERE id = ?").run(id)
}

export function resumeWatch(db: Database.Database, id: number): void {
  db.prepare("UPDATE watches SET status = 'active' WHERE id = ?").run(id)
}

export function markWatchTriggered(db: Database.Database, id: number): void {
  db.prepare(
    "UPDATE watches SET last_triggered = datetime('now','localtime'), trigger_count = trigger_count + 1 WHERE id = ?"
  ).run(id)
}

// ─── Settings ───────────────────────────────────────────────

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now','localtime')`
    )
    .run(key, value, value)
}

export function getAllSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return result
}

// ─── Task Runs ──────────────────────────────────────────────

export function createTaskRun(db: Database.Database, taskId: number): TaskRun {
  const result = db.prepare("INSERT INTO task_runs (task_id, started_at) VALUES (?, datetime('now','localtime'))").run(taskId)
  return getTaskRun(db, result.lastInsertRowid as number)!
}

export function getTaskRun(db: Database.Database, id: number): TaskRun | null {
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapTaskRunRow(row) : null
}

export function completeTaskRun(db: Database.Database, id: number, result: string, resultFile?: string, errorMessage?: string): void {
  const run = getTaskRun(db, id)
  if (!run) return

  const status = errorMessage ? 'failed' : 'completed'
  const durationMs = Date.now() - new Date(run.startedAt).getTime()

  db.prepare(
    `UPDATE task_runs SET finished_at = datetime('now','localtime'), status = ?, result = ?,
     result_file = ?, error_message = ?, duration_ms = ? WHERE id = ?`
  ).run(status, result, resultFile ?? null, errorMessage ?? null, durationMs, id)

  const task = getTask(db, run.taskId)
  const newErrorCount = errorMessage ? (task?.errorCount ?? 0) + 1 : 0
  db.prepare(
    `UPDATE tasks SET last_run = datetime('now','localtime'), last_result = ?,
     error_count = ?, updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(result, newErrorCount, run.taskId)
}

export function getTaskRuns(db: Database.Database, taskId: number, limit: number = 20): TaskRun[] {
  const safeLimit = clampLimit(limit, 20, 500)
  const rows = db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(taskId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapTaskRunRow)
}

export function listAllRuns(db: Database.Database, limit: number = 20): TaskRun[] {
  const safeLimit = clampLimit(limit, 20, 500)
  const rows = db
    .prepare('SELECT * FROM task_runs ORDER BY started_at DESC LIMIT ?')
    .all(safeLimit)
  return (rows as Record<string, unknown>[]).map(mapTaskRunRow)
}

export function listRunsByRoom(db: Database.Database, roomId: number, limit: number = 50): TaskRun[] {
  const safeLimit = clampLimit(limit, 50, 500)
  const rows = db
    .prepare(`SELECT tr.* FROM task_runs tr
              JOIN tasks t ON tr.task_id = t.id
              WHERE t.room_id = ?
              ORDER BY tr.started_at DESC LIMIT ?`)
    .all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapTaskRunRow)
}

export function getLatestTaskRun(db: Database.Database, taskId: number): TaskRun | null {
  const row = db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(taskId) as Record<string, unknown> | undefined
  return row ? mapTaskRunRow(row) : null
}

// ─── One-Time & Progress Queries ────────────────────────────

export function getDueOnceTasks(db: Database.Database): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE trigger_type = 'once'
         AND status = 'active'
         AND scheduled_at IS NOT NULL
         AND datetime(scheduled_at) <= datetime('now','localtime')
       ORDER BY scheduled_at ASC`
    )
    .all()
  return (rows as Record<string, unknown>[]).map(mapTaskRow)
}

export function updateTaskRunProgress(db: Database.Database, runId: number, progress: number | null, progressMessage: string | null): void {
  db.prepare(
    'UPDATE task_runs SET progress = ?, progress_message = ? WHERE id = ?'
  ).run(progress, progressMessage, runId)
}

export function getRunningTaskRuns(db: Database.Database): TaskRun[] {
  const rows = db
    .prepare("SELECT * FROM task_runs WHERE status = 'running' ORDER BY started_at DESC")
    .all()
  return (rows as Record<string, unknown>[]).map(mapTaskRunRow)
}

// ─── Stale Run Cleanup ─────────────────────────────────────

const DEFAULT_TIMEOUT_MINUTES = 30

/**
 * Mark ALL "running" runs as failed. Use on startup — if the process restarted,
 * no run can still be legitimately running.
 */
export function cleanupAllRunningRuns(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE task_runs SET
      status = 'failed',
      finished_at = datetime('now','localtime'),
      error_message = 'Stale run: process restarted'
    WHERE status = 'running'
  `).run()
  return result.changes
}

/**
 * Mark "running" runs as failed if they've exceeded their timeout.
 * Use in periodic scheduler checks (where a run might legitimately be in progress).
 */
export function cleanupStaleRuns(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE task_runs SET
      status = 'failed',
      finished_at = datetime('now','localtime'),
      error_message = 'Stale run: exceeded timeout'
    WHERE status = 'running'
      AND (julianday('now','localtime') - julianday(started_at)) * 24 * 60 >
        COALESCE(
          (SELECT timeout_minutes FROM tasks WHERE tasks.id = task_runs.task_id),
          ?
        )
  `).run(DEFAULT_TIMEOUT_MINUTES)
  return result.changes
}

// ─── Pruning ──────────────────────────────────────────────

const MAX_RUNS_PER_TASK = 50
const PRUNE_INTERVAL_MS = 60 * 60_000 // 1 hour
let lastPruneTime = 0

/**
 * Delete old task runs (keeping last N per task) and their console logs.
 * Runs at most once per hour to avoid overhead.
 * Uses ROW_NUMBER() window function for O(n) instead of O(n²) correlated subquery.
 */
export function pruneOldRuns(db: Database.Database): number {
  const now = Date.now()
  if (now - lastPruneTime < PRUNE_INTERVAL_MS) return 0
  lastPruneTime = now

  // Find run IDs to prune using window function (O(n) scan)
  const staleIds = db.prepare(`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS rn
      FROM task_runs
    ) WHERE rn > ?
  `).all(MAX_RUNS_PER_TASK) as Array<{ id: number }>

  if (staleIds.length === 0) return 0

  const ids = staleIds.map(r => r.id)
  const placeholders = ids.map(() => '?').join(',')

  // Delete console logs then runs in a single transaction
  const deleteAll = db.transaction(() => {
    const logResult = db.prepare(
      `DELETE FROM console_logs WHERE run_id IN (${placeholders})`
    ).run(...ids)
    const runResult = db.prepare(
      `DELETE FROM task_runs WHERE id IN (${placeholders})`
    ).run(...ids)
    return logResult.changes + runResult.changes
  })

  return deleteAll()
}

// ─── Console Logs ──────────────────────────────────────────

export function insertConsoleLogs(
  db: Database.Database,
  entries: Array<{ runId: number; seq: number; entryType: string; content: string }>
): void {
  const stmt = db.prepare(
    'INSERT INTO console_logs (run_id, seq, entry_type, content) VALUES (?, ?, ?, ?)'
  )
  const insertMany = db.transaction((items: typeof entries) => {
    for (const e of items) {
      stmt.run(e.runId, e.seq, e.entryType, e.content)
    }
  })
  insertMany(entries)
}

export function getConsoleLogs(
  db: Database.Database,
  runId: number,
  afterSeq: number = 0,
  limit: number = 100
): ConsoleLogEntry[] {
  const safeAfterSeq = Number.isFinite(afterSeq) ? Math.max(0, Math.trunc(afterSeq)) : 0
  const safeLimit = clampLimit(limit, 100, 1000)
  const rows = db
    .prepare('SELECT * FROM console_logs WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(runId, safeAfterSeq, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapConsoleLogRow)
}

function mapConsoleLogRow(row: Record<string, unknown>): ConsoleLogEntry {
  return {
    id: row.id as number,
    runId: row.run_id as number,
    seq: row.seq as number,
    entryType: row.entry_type as string,
    content: row.content as string,
    createdAt: row.created_at as string
  }
}

// ─── Memory-Task Integration ────────────────────────────────

const MAX_OWN_OBSERVATIONS = 5
const MAX_RELATED_OBSERVATIONS = 3
const MAX_MEMORY_LENGTH = 2000
const MAX_OBSERVATIONS_PER_ENTITY = 10

function buildRelatedKnowledgeSection(db: Database.Database, task: Task): string | null {
  // Single FTS search with all words joined by OR instead of N separate queries
  const words = task.name.split(/\s+/).filter(w => w.length >= 2)
  if (words.length === 0) return null

  const relatedMap = new Map<number, Entity>()
  try {
    const ftsQuery = words.join(' OR ')
    const ftsResults = db
      .prepare(
        `SELECT e.* FROM entities e
         INNER JOIN memory_fts fts ON e.id = fts.rowid
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT 10`
      )
      .all(ftsQuery) as Entity[]
    for (const entity of ftsResults) {
      if (entity.id !== task.memoryEntityId) {
        relatedMap.set(entity.id, entity)
      }
    }
  } catch {
    // FTS parse error — fall through to LIKE
    const escaped = words.map(w => w.replace(/[%_]/g, '\\$&'))
    const likeConditions = escaped.map(() => "name LIKE ? ESCAPE '\\'").join(' OR ')
    const params = escaped.map(w => `%${w}%`)
    const rows = db
      .prepare(`SELECT * FROM entities WHERE ${likeConditions} ORDER BY updated_at DESC LIMIT 10`)
      .all(...params) as Entity[]
    for (const entity of rows) {
      if (entity.id !== task.memoryEntityId) {
        relatedMap.set(entity.id, entity)
      }
    }
  }

  const entityIds = Array.from(relatedMap.keys()).slice(0, 5)
  if (entityIds.length === 0) return null

  // Batch fetch observations for all entities in a single query
  const placeholders = entityIds.map(() => '?').join(',')
  const allObs = db
    .prepare(
      `SELECT * FROM observations WHERE entity_id IN (${placeholders}) ORDER BY id DESC`
    )
    .all(...entityIds) as Observation[]

  // Group by entity_id, keeping only top N per entity
  const obsByEntity = new Map<number, Observation[]>()
  for (const obs of allObs) {
    const list = obsByEntity.get(obs.entity_id) ?? []
    if (list.length < MAX_RELATED_OBSERVATIONS) {
      list.push(obs)
      obsByEntity.set(obs.entity_id, list)
    }
  }

  const relatedParts: string[] = []
  for (const id of entityIds) {
    const entity = relatedMap.get(id)!
    const observations = obsByEntity.get(id)
    if (observations && observations.length > 0) {
      const obsText = observations.map(o => o.content).join('\n')
      relatedParts.push(`**${entity.name}** (${entity.type}):\n${obsText}`)
    }
  }
  return relatedParts.length > 0 ? `## Related knowledge:\n${relatedParts.join('\n\n')}` : null
}

export function getTaskMemoryContext(db: Database.Database, taskId: number): string | null {
  const task = getTask(db, taskId)
  if (!task) return null

  const sections: string[] = []

  // 1. Own task's recent observations
  if (task.memoryEntityId) {
    const entity = getEntity(db, task.memoryEntityId)
    if (entity) {
      const observations = getObservations(db, entity.id)
      if (observations.length > 0) {
        const recent = observations.slice(0, MAX_OWN_OBSERVATIONS)
        const obsText = recent.map(o => `[${o.created_at}] ${o.content}`).join('\n\n')
        sections.push(`## Your previous results:\n${obsText}`)
      }
    }
  }

  // 2. Related knowledge from all memory (other tasks, user memories)
  const relatedSection = buildRelatedKnowledgeSection(db, task)
  if (relatedSection) sections.push(relatedSection)

  return sections.length > 0 ? sections.join('\n\n') : null
}

export function ensureTaskMemoryEntity(db: Database.Database, taskId: number): number {
  const task = getTask(db, taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  if (task.memoryEntityId) {
    const existing = getEntity(db, task.memoryEntityId)
    if (existing) return existing.id
  }

  const entity = createEntity(db, `Task: ${task.name}`, 'task_result', 'task')
  updateTask(db, taskId, { memoryEntityId: entity.id })
  return entity.id
}

export function storeTaskResultInMemory(
  db: Database.Database,
  taskId: number,
  result: string,
  success: boolean
): void {
  const entityId = ensureTaskMemoryEntity(db, taskId)

  const truncated = result.length > MAX_MEMORY_LENGTH
    ? result.substring(0, MAX_MEMORY_LENGTH) + '\n[...truncated]'
    : result

  const status = success ? 'SUCCESS' : 'FAILED'
  const content = `[${status}] ${truncated}`

  addObservation(db, entityId, content, 'task_runner')

  // Prune old observations — keep last N to prevent unbounded growth
  // Use COUNT + targeted DELETE instead of loading all observations into memory
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM observations WHERE entity_id = ?').get(entityId) as { cnt: number }
  if (countRow.cnt > MAX_OBSERVATIONS_PER_ENTITY) {
    db.prepare(
      `DELETE FROM observations WHERE id IN (
         SELECT id FROM observations WHERE entity_id = ?
         ORDER BY id DESC LIMIT -1 OFFSET ?
       )`
    ).run(entityId, MAX_OBSERVATIONS_PER_ENTITY)
  }
}

export function incrementRunCount(db: Database.Database, taskId: number): void {
  // Atomic: increment run_count and auto-complete if maxRuns reached in a single statement
  db.prepare(
    `UPDATE tasks SET
       run_count = run_count + 1,
       status = CASE WHEN max_runs IS NOT NULL AND run_count + 1 >= max_runs THEN 'completed' ELSE status END,
       updated_at = datetime('now','localtime')
     WHERE id = ?`
  ).run(taskId)
}

// ─── Task Row Mappers ───────────────────────────────────────

function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    name: row.name as string,
    description: row.description as string | null,
    prompt: row.prompt as string,
    cronExpression: row.cron_expression as string | null,
    triggerType: row.trigger_type as TriggerType,
    triggerConfig: row.trigger_config as string | null,
    webhookToken: row.webhook_token as string | null,
    scheduledAt: row.scheduled_at as string | null,
    executor: row.executor as string,
    status: row.status as TaskStatus,
    lastRun: row.last_run as string | null,
    lastResult: row.last_result as string | null,
    errorCount: row.error_count as number,
    maxRuns: row.max_runs as number | null,
    runCount: (row.run_count as number) ?? 0,
    memoryEntityId: row.memory_entity_id as number | null,
    workerId: row.worker_id as number | null,
    sessionContinuity: (row.session_continuity as number) === 1,
    sessionId: row.session_id as string | null,
    timeoutMinutes: row.timeout_minutes as number | null,
    maxTurns: row.max_turns as number | null,
    allowedTools: row.allowed_tools as string | null,
    disallowedTools: row.disallowed_tools as string | null,
    learnedContext: row.learned_context as string | null,
    roomId: (row.room_id as number | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function mapWatchRow(row: Record<string, unknown>): Watch {
  return {
    id: row.id as number,
    path: row.path as string,
    description: row.description as string | null,
    actionPrompt: row.action_prompt as string | null,
    status: row.status as string,
    lastTriggered: row.last_triggered as string | null,
    triggerCount: row.trigger_count as number,
    roomId: (row.room_id as number | null) ?? null,
    createdAt: row.created_at as string
  }
}

function mapTaskRunRow(row: Record<string, unknown>): TaskRun {
  return {
    id: row.id as number,
    taskId: row.task_id as number,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as string,
    result: row.result as string | null,
    resultFile: row.result_file as string | null,
    errorMessage: row.error_message as string | null,
    durationMs: row.duration_ms as number | null,
    progress: row.progress as number | null,
    progressMessage: row.progress_message as string | null,
    sessionId: row.session_id as string | null
  }
}

// ─── Session Continuity ────────────────────────────────────

export function updateTaskRunSessionId(db: Database.Database, runId: number, sessionId: string): void {
  db.prepare('UPDATE task_runs SET session_id = ? WHERE id = ?').run(sessionId, runId)
}

export function clearTaskSession(db: Database.Database, taskId: number): void {
  db.prepare("UPDATE tasks SET session_id = NULL, updated_at = datetime('now','localtime') WHERE id = ?").run(taskId)
}

export function getSessionRunCount(db: Database.Database, taskId: number, sessionId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM task_runs WHERE task_id = ? AND session_id = ?'
  ).get(taskId, sessionId) as { count: number }
  return row.count
}

export function getCrossTaskMemoryContext(db: Database.Database, taskId: number): string | null {
  const task = getTask(db, taskId)
  if (!task) return null
  return buildRelatedKnowledgeSection(db, task)
}

// ─── Embeddings ────────────────────────────────────────────

export function upsertEmbedding(
  db: Database.Database,
  entityId: number,
  sourceType: 'entity' | 'observation',
  sourceId: number,
  hash: string,
  vector: Buffer,
  model: string,
  dimensions: number
): void {
  db.prepare(
    `INSERT INTO embeddings (entity_id, source_type, source_id, text_hash, vector, model, dimensions)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_type, source_id, model) DO UPDATE SET
       text_hash = excluded.text_hash,
       vector = excluded.vector,
       created_at = datetime('now','localtime')`
  ).run(entityId, sourceType, sourceId, hash, vector, model, dimensions)

  db.prepare("UPDATE entities SET embedded_at = datetime('now','localtime') WHERE id = ?").run(entityId)
}

export function getEmbeddingsForEntity(db: Database.Database, entityId: number): Array<{
  sourceType: string; sourceId: number; vector: Buffer; textHash: string
}> {
  const rows = db.prepare(
    'SELECT source_type, source_id, vector, text_hash FROM embeddings WHERE entity_id = ?'
  ).all(entityId) as Array<Record<string, unknown>>
  return rows.map(r => ({
    sourceType: r.source_type as string,
    sourceId: r.source_id as number,
    vector: r.vector as Buffer,
    textHash: r.text_hash as string
  }))
}

export function getAllEmbeddings(db: Database.Database): Array<{
  entityId: number; sourceType: string; sourceId: number; vector: Buffer
}> {
  const rows = db.prepare(
    'SELECT entity_id, source_type, source_id, vector FROM embeddings'
  ).all() as Array<Record<string, unknown>>
  return rows.map(r => ({
    entityId: r.entity_id as number,
    sourceType: r.source_type as string,
    sourceId: r.source_id as number,
    vector: r.vector as Buffer
  }))
}

export function deleteEmbeddingsForEntity(db: Database.Database, entityId: number): void {
  db.prepare('DELETE FROM embeddings WHERE entity_id = ?').run(entityId)
}

export function getUnembeddedEntities(db: Database.Database, limit: number = 50): Entity[] {
  const safeLimit = clampLimit(limit, 50, 500)
  return db.prepare(
    'SELECT * FROM entities WHERE embedded_at IS NULL ORDER BY created_at ASC LIMIT ?'
  ).all(safeLimit) as Entity[]
}

// ─── Semantic Search (sqlite-vec) ─────────────────────────

/**
 * Vector similarity search using sqlite-vec's vec_distance_cosine().
 * Runs entirely in SQLite — no JS loop, no loading all embeddings into memory.
 * Returns entity IDs with similarity scores (1 - cosine_distance).
 */
export function semanticSearchSql(
  db: Database.Database,
  queryVector: Buffer,
  limit: number = 20,
  minSimilarity: number = 0.3
): Array<{ entityId: number; score: number }> {
  const safeLimit = clampLimit(limit, 20, 200)
  const rows = db.prepare(`
    SELECT entity_id, 1.0 - vec_distance_cosine(vector, ?) AS similarity
    FROM embeddings
    WHERE similarity >= ?
    ORDER BY similarity DESC
    LIMIT ?
  `).all(queryVector, minSimilarity, safeLimit) as Array<{ entity_id: number; similarity: number }>
  return rows.map(r => ({ entityId: r.entity_id, score: r.similarity }))
}

// ─── Hybrid Search (FTS + Semantic) ───────────────────────

interface HybridSearchResult {
  entity: Entity
  ftsScore: number
  semanticScore: number
  combinedScore: number
}

export function hybridSearch(
  db: Database.Database,
  query: string,
  semanticResults: Array<{ entityId: number; score: number }> | null,
  limit: number = 10
): HybridSearchResult[] {
  const safeLimit = clampLimit(limit, 10, 200)
  // 1. FTS search
  const ftsEntities = searchEntities(db, query)
  const ftsMap = new Map<number, { entity: Entity; rank: number }>()
  ftsEntities.forEach((e, i) => ftsMap.set(e.id, { entity: e, rank: i + 1 }))

  // 2. Semantic results (pre-computed by caller — either sqlite-vec SQL or JS fallback)
  const semMap = new Map<number, number>()
  if (semanticResults) {
    for (const r of semanticResults) {
      semMap.set(r.entityId, r.score)
    }
  }

  // 3. Merge with reciprocal rank fusion
  const allIds = new Set([...ftsMap.keys(), ...semMap.keys()])
  const results: HybridSearchResult[] = []

  for (const id of allIds) {
    const ftsEntry = ftsMap.get(id)
    const ftsScore = ftsEntry ? 1 / (60 + ftsEntry.rank) : 0 // RRF with k=60
    const semanticScore = semMap.get(id) ?? 0

    const entity = ftsEntry?.entity ?? getEntity(db, id)
    if (!entity) continue

    const combinedScore = ftsScore * 0.4 + semanticScore * 0.6
    results.push({ entity, ftsScore, semanticScore, combinedScore })
  }

  results.sort((a, b) => b.combinedScore - a.combinedScore)
  return results.slice(0, safeLimit)
}

// ─── Rooms ──────────────────────────────────────────────────

function mapRoomRow(row: Record<string, unknown>): Room {
  let config: RoomConfig = { ...DEFAULT_ROOM_CONFIG }
  try {
    if (row.config) config = { ...DEFAULT_ROOM_CONFIG, ...JSON.parse(row.config as string) }
  } catch { /* use defaults */ }
  return {
    id: row.id as number,
    name: row.name as string,
    queenWorkerId: (row.queen_worker_id as number | null) ?? null,
    goal: (row.goal as string | null) ?? null,
    status: (row.status as string) as Room['status'],
    visibility: (row.visibility as string) as Room['visibility'],
    autonomyMode: ((row.autonomy_mode as string) ?? 'auto') as 'auto' | 'semi',
    maxConcurrentTasks: (row.max_concurrent_tasks as number) ?? 3,
    workerModel: (row.worker_model as string) ?? 'claude',
    queenCycleGapMs: (row.queen_cycle_gap_ms as number) ?? 1_800_000,
    queenMaxTurns: (row.queen_max_turns as number) ?? 3,
    queenQuietFrom: (row.queen_quiet_from as string | null) ?? null,
    queenQuietUntil: (row.queen_quiet_until as string | null) ?? null,
    config,
    queenNickname: (row.queen_nickname as string | null) ?? null,
    chatSessionId: (row.chat_session_id as string | null) ?? null,
    referredByCode: (row.referred_by_code as string | null) ?? null,
    allowedTools: (row.allowed_tools as string | null) ?? null,
    webhookToken: (row.webhook_token as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function createRoom(db: Database.Database, name: string, goal?: string, config?: Partial<RoomConfig>, referredByCode?: string, queenNickname?: string): Room {
  const configJson = config ? JSON.stringify({ ...DEFAULT_ROOM_CONFIG, ...config }) : JSON.stringify(DEFAULT_ROOM_CONFIG)
  const nickname = queenNickname ?? pickQueenNickname(db)
  const result = db
    .prepare('INSERT INTO rooms (name, goal, config, referred_by_code, queen_nickname) VALUES (?, ?, ?, ?, ?)')
    .run(name, goal ?? null, configJson, referredByCode ?? null, nickname)
  return getRoom(db, result.lastInsertRowid as number)!
}

const QUEEN_WOMAN_NAMES = [
  'Alice', 'Anna', 'Belle', 'Cara', 'Dana', 'Elena', 'Fiona', 'Grace',
  'Hana', 'Iris', 'Julia', 'Kate', 'Lena', 'Luna', 'Mara', 'Maya',
  'Nina', 'Nora', 'Olga', 'Petra', 'Rose', 'Sara', 'Sofia', 'Tara',
  'Uma', 'Vera', 'Wren', 'Zara', 'Zoe', 'Ava', 'Cleo', 'Dara',
  'Emmy', 'Gaia', 'Hera', 'Ines', 'Jada', 'Kara', 'Lila', 'Mina',
]

export function pickQueenNickname(db: Database.Database): string {
  const usedNames = (db.prepare(`SELECT queen_nickname FROM rooms WHERE queen_nickname IS NOT NULL AND queen_nickname != ''`).all() as { queen_nickname: string }[]).map(r => r.queen_nickname.toLowerCase())
  const available = QUEEN_WOMAN_NAMES.filter(n => !usedNames.includes(n.toLowerCase()))
  const pool = available.length > 0 ? available : QUEEN_WOMAN_NAMES
  return pool[Math.floor(Math.random() * pool.length)]
}

export function getRoom(db: Database.Database, id: number): Room | null {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapRoomRow(row) : null
}

export function getRoomByWebhookToken(db: Database.Database, token: string): Room | null {
  const row = db.prepare('SELECT * FROM rooms WHERE webhook_token = ?').get(token) as Record<string, unknown> | undefined
  return row ? mapRoomRow(row) : null
}

export function listRooms(db: Database.Database, status?: string): Room[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM rooms WHERE status = ? ORDER BY created_at DESC').all(status)
    return (rows as Record<string, unknown>[]).map(mapRoomRow)
  }
  const rows = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(mapRoomRow)
}

export function updateRoom(db: Database.Database, id: number, updates: Partial<{
  name: string; queenWorkerId: number | null; goal: string | null; status: string; visibility: string; autonomyMode: string; maxConcurrentTasks: number; workerModel: string; queenCycleGapMs: number; queenMaxTurns: number; queenQuietFrom: string | null; queenQuietUntil: string | null; config: RoomConfig; referredByCode: string | null; queenNickname: string; allowedTools: string | null; webhookToken: string | null
}>): void {
  const fieldMap: Record<string, string> = {
    name: 'name', queenWorkerId: 'queen_worker_id', goal: 'goal',
    status: 'status', visibility: 'visibility', autonomyMode: 'autonomy_mode',
    maxConcurrentTasks: 'max_concurrent_tasks', workerModel: 'worker_model',
    queenCycleGapMs: 'queen_cycle_gap_ms', queenMaxTurns: 'queen_max_turns',
    queenQuietFrom: 'queen_quiet_from', queenQuietUntil: 'queen_quiet_until',
    config: 'config', referredByCode: 'referred_by_code', queenNickname: 'queen_nickname',
    allowedTools: 'allowed_tools', webhookToken: 'webhook_token'
  }
  const fields: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(updates)) {
    const dbField = fieldMap[key]
    if (dbField) {
      fields.push(`${dbField} = ?`)
      values.push(key === 'config' ? JSON.stringify(value) : value)
    }
  }
  if (fields.length === 0) return

  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE rooms SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteRoom(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
}

// ─── Room Activity ──────────────────────────────────────────

function mapRoomActivityRow(row: Record<string, unknown>): RoomActivityEntry {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    eventType: row.event_type as ActivityEventType,
    actorId: (row.actor_id as number | null) ?? null,
    summary: row.summary as string,
    details: (row.details as string | null) ?? null,
    isPublic: (row.is_public as number) === 1,
    createdAt: row.created_at as string
  }
}

export function logRoomActivity(
  db: Database.Database, roomId: number, eventType: ActivityEventType,
  summary: string, details?: string, actorId?: number, isPublic: boolean = true
): RoomActivityEntry {
  const result = db
    .prepare('INSERT INTO room_activity (room_id, event_type, actor_id, summary, details, is_public) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomId, eventType, actorId ?? null, summary, details ?? null, isPublic ? 1 : 0)
  const row = db.prepare('SELECT * FROM room_activity WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return mapRoomActivityRow(row)
}

export function getRoomActivity(
  db: Database.Database, roomId: number, limit: number = 50, eventTypes?: ActivityEventType[]
): RoomActivityEntry[] {
  const safeLimit = clampLimit(limit, 50, 500)
  if (eventTypes && eventTypes.length > 0) {
    const placeholders = eventTypes.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT * FROM room_activity WHERE room_id = ? AND event_type IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
      .all(roomId, ...eventTypes, safeLimit)
    return (rows as Record<string, unknown>[]).map(mapRoomActivityRow)
  }
  const rows = db
    .prepare('SELECT * FROM room_activity WHERE room_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapRoomActivityRow)
}

// ─── Quorum Decisions ───────────────────────────────────────

function mapDecisionRow(row: Record<string, unknown>): QuorumDecision {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    proposerId: (row.proposer_id as number | null) ?? null,
    proposal: row.proposal as string,
    decisionType: row.decision_type as DecisionType,
    status: row.status as DecisionStatus,
    result: (row.result as string | null) ?? null,
    threshold: row.threshold as string,
    timeoutAt: (row.timeout_at as string | null) ?? null,
    keeperVote: (row.keeper_vote as VoteValue | null) ?? null,
    minVoters: (row.min_voters as number) ?? 0,
    sealed: ((row.sealed as number) ?? 0) === 1,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null
  }
}

export function createDecision(
  db: Database.Database, roomId: number, proposerId: number | null,
  proposal: string, decisionType: DecisionType, threshold: string = 'majority',
  timeoutAt?: string, minVoters: number = 0, sealed: boolean = false
): QuorumDecision {
  const result = db
    .prepare('INSERT INTO quorum_decisions (room_id, proposer_id, proposal, decision_type, threshold, timeout_at, min_voters, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(roomId, proposerId, proposal, decisionType, threshold, timeoutAt ?? null, minVoters, sealed ? 1 : 0)
  return getDecision(db, result.lastInsertRowid as number)!
}

export function getDecision(db: Database.Database, id: number): QuorumDecision | null {
  const row = db.prepare('SELECT * FROM quorum_decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapDecisionRow(row) : null
}

export function listDecisions(db: Database.Database, roomId: number, status?: DecisionStatus): QuorumDecision[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM quorum_decisions WHERE room_id = ? AND status = ? ORDER BY created_at DESC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapDecisionRow)
  }
  const rows = db.prepare('SELECT * FROM quorum_decisions WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
  return (rows as Record<string, unknown>[]).map(mapDecisionRow)
}

export function resolveDecision(db: Database.Database, id: number, status: DecisionStatus, result?: string): void {
  db.prepare("UPDATE quorum_decisions SET status = ?, result = ?, resolved_at = datetime('now','localtime') WHERE id = ?")
    .run(status, result ?? null, id)
}

export function setKeeperVote(db: Database.Database, decisionId: number, vote: VoteValue): void {
  db.prepare('UPDATE quorum_decisions SET keeper_vote = ? WHERE id = ?').run(vote, decisionId)
}

export function getExpiredDecisions(db: Database.Database): QuorumDecision[] {
  const rows = db.prepare("SELECT * FROM quorum_decisions WHERE status = 'voting' AND timeout_at IS NOT NULL AND timeout_at <= datetime('now','localtime')").all()
  return (rows as Record<string, unknown>[]).map(mapDecisionRow)
}

// ─── Quorum Votes ───────────────────────────────────────────

function mapVoteRow(row: Record<string, unknown>): QuorumVote {
  return {
    id: row.id as number,
    decisionId: row.decision_id as number,
    workerId: row.worker_id as number,
    vote: row.vote as VoteValue,
    reasoning: (row.reasoning as string | null) ?? null,
    createdAt: row.created_at as string
  }
}

export function castVote(
  db: Database.Database, decisionId: number, workerId: number, vote: VoteValue, reasoning?: string
): QuorumVote {
  const result = db
    .prepare('INSERT INTO quorum_votes (decision_id, worker_id, vote, reasoning) VALUES (?, ?, ?, ?)')
    .run(decisionId, workerId, vote, reasoning ?? null)
  const row = db.prepare('SELECT * FROM quorum_votes WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return mapVoteRow(row)
}

export function getVotes(db: Database.Database, decisionId: number): QuorumVote[] {
  const rows = db.prepare('SELECT * FROM quorum_votes WHERE decision_id = ? ORDER BY created_at ASC').all(decisionId)
  return (rows as Record<string, unknown>[]).map(mapVoteRow)
}

// ─── Voter Health ───────────────────────────────────────────

export function incrementVotesCast(db: Database.Database, workerId: number): void {
  db.prepare('UPDATE workers SET votes_cast = votes_cast + 1 WHERE id = ?').run(workerId)
}

export function incrementVotesMissed(db: Database.Database, workerId: number): void {
  db.prepare('UPDATE workers SET votes_missed = votes_missed + 1 WHERE id = ?').run(workerId)
}

export interface VoterHealthRecord {
  workerId: number
  workerName: string
  votesCast: number
  votesMissed: number
  totalDecisions: number
  participationRate: number
  isHealthy: boolean
}

export function getVoterHealth(db: Database.Database, roomId: number, threshold: number = 0.5): VoterHealthRecord[] {
  const workers = listRoomWorkers(db, roomId)
  return workers.map(w => {
    const total = w.votesCast + w.votesMissed
    const rate = total === 0 ? 1.0 : w.votesCast / total
    return {
      workerId: w.id,
      workerName: w.name,
      votesCast: w.votesCast,
      votesMissed: w.votesMissed,
      totalDecisions: total,
      participationRate: rate,
      isHealthy: rate >= threshold
    }
  })
}

// ─── Goals ──────────────────────────────────────────────────

function mapGoalRow(row: Record<string, unknown>): Goal {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    description: row.description as string,
    status: row.status as GoalStatus,
    parentGoalId: (row.parent_goal_id as number | null) ?? null,
    assignedWorkerId: (row.assigned_worker_id as number | null) ?? null,
    progress: (row.progress as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function createGoal(
  db: Database.Database, roomId: number, description: string,
  parentGoalId?: number, assignedWorkerId?: number
): Goal {
  const result = db
    .prepare('INSERT INTO goals (room_id, description, parent_goal_id, assigned_worker_id) VALUES (?, ?, ?, ?)')
    .run(roomId, description, parentGoalId ?? null, assignedWorkerId ?? null)
  return getGoal(db, result.lastInsertRowid as number)!
}

export function getGoal(db: Database.Database, id: number): Goal | null {
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapGoalRow(row) : null
}

export function listGoals(db: Database.Database, roomId: number, status?: GoalStatus): Goal[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM goals WHERE room_id = ? AND status = ? ORDER BY created_at ASC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapGoalRow)
  }
  const rows = db.prepare('SELECT * FROM goals WHERE room_id = ? ORDER BY created_at ASC').all(roomId)
  return (rows as Record<string, unknown>[]).map(mapGoalRow)
}

export function getSubGoals(db: Database.Database, parentGoalId: number): Goal[] {
  const rows = db.prepare('SELECT * FROM goals WHERE parent_goal_id = ? ORDER BY created_at ASC').all(parentGoalId)
  return (rows as Record<string, unknown>[]).map(mapGoalRow)
}

export function updateGoal(db: Database.Database, id: number, updates: Partial<{
  description: string; status: GoalStatus; assignedWorkerId: number | null; progress: number
}>): void {
  const fieldMap: Record<string, string> = {
    description: 'description', status: 'status',
    assignedWorkerId: 'assigned_worker_id', progress: 'progress'
  }
  const fields: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(updates)) {
    const dbField = fieldMap[key]
    if (dbField) {
      fields.push(`${dbField} = ?`)
      values.push(value)
    }
  }
  if (fields.length === 0) return

  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE goals SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteGoal(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM goals WHERE id = ?').run(id)
}

// ─── Goal Updates ───────────────────────────────────────────

function mapGoalUpdateRow(row: Record<string, unknown>): GoalUpdate {
  return {
    id: row.id as number,
    goalId: row.goal_id as number,
    workerId: (row.worker_id as number | null) ?? null,
    observation: row.observation as string,
    metricValue: (row.metric_value as number | null) ?? null,
    createdAt: row.created_at as string
  }
}

export function logGoalUpdate(
  db: Database.Database, goalId: number, observation: string,
  metricValue?: number, workerId?: number
): GoalUpdate {
  const result = db
    .prepare('INSERT INTO goal_updates (goal_id, worker_id, observation, metric_value) VALUES (?, ?, ?, ?)')
    .run(goalId, workerId ?? null, observation, metricValue ?? null)
  const row = db.prepare('SELECT * FROM goal_updates WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return mapGoalUpdateRow(row)
}

export function getGoalUpdates(db: Database.Database, goalId: number, limit: number = 50): GoalUpdate[] {
  const safeLimit = clampLimit(limit, 50, 500)
  const rows = db.prepare('SELECT * FROM goal_updates WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?').all(goalId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapGoalUpdateRow)
}

export function recalculateGoalProgress(db: Database.Database, goalId: number): number {
  const subGoals = getSubGoals(db, goalId)
  if (subGoals.length > 0) {
    const avg = subGoals.reduce((sum, g) => sum + g.progress, 0) / subGoals.length
    const progress = Math.round(avg * 1000) / 1000
    updateGoal(db, goalId, { progress })
    return progress
  }
  const goal = getGoal(db, goalId)
  return goal?.progress ?? 0
}

// ─── Skills ─────────────────────────────────────────────────

function mapSkillRow(row: Record<string, unknown>): Skill {
  let activationContext: string[] | null = null
  try {
    if (row.activation_context) activationContext = JSON.parse(row.activation_context as string)
  } catch { /* leave null */ }
  return {
    id: row.id as number,
    roomId: (row.room_id as number | null) ?? null,
    name: row.name as string,
    content: row.content as string,
    activationContext,
    autoActivate: (row.auto_activate as number) === 1,
    agentCreated: (row.agent_created as number) === 1,
    createdByWorkerId: (row.created_by_worker_id as number | null) ?? null,
    version: (row.version as number) ?? 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function createSkill(
  db: Database.Database, roomId: number | null, name: string, content: string,
  opts?: { activationContext?: string[]; autoActivate?: boolean; agentCreated?: boolean; createdByWorkerId?: number }
): Skill {
  const result = db
    .prepare('INSERT INTO skills (room_id, name, content, activation_context, auto_activate, agent_created, created_by_worker_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      roomId, name, content,
      opts?.activationContext ? JSON.stringify(opts.activationContext) : null,
      opts?.autoActivate ? 1 : 0,
      opts?.agentCreated ? 1 : 0,
      opts?.createdByWorkerId ?? null
    )
  return getSkill(db, result.lastInsertRowid as number)!
}

export function getSkill(db: Database.Database, id: number): Skill | null {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapSkillRow(row) : null
}

export function listSkills(db: Database.Database, roomId?: number): Skill[] {
  if (roomId != null) {
    const rows = db.prepare('SELECT * FROM skills WHERE room_id = ? ORDER BY name ASC').all(roomId)
    return (rows as Record<string, unknown>[]).map(mapSkillRow)
  }
  const rows = db.prepare('SELECT * FROM skills ORDER BY name ASC').all()
  return (rows as Record<string, unknown>[]).map(mapSkillRow)
}

export function updateSkill(db: Database.Database, id: number, updates: Partial<{
  name: string; content: string; activationContext: string[] | null; autoActivate: boolean; version: number
}>): void {
  const fields: string[] = []
  const values: unknown[] = []

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content) }
  if (updates.activationContext !== undefined) {
    fields.push('activation_context = ?')
    values.push(updates.activationContext ? JSON.stringify(updates.activationContext) : null)
  }
  if (updates.autoActivate !== undefined) { fields.push('auto_activate = ?'); values.push(updates.autoActivate ? 1 : 0) }
  if (updates.version !== undefined) { fields.push('version = ?'); values.push(updates.version) }

  if (fields.length === 0) return
  fields.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteSkill(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM skills WHERE id = ?').run(id)
}

export function getActiveSkillsForContext(db: Database.Database, roomId: number, contextText: string): Skill[] {
  const skills = db.prepare('SELECT * FROM skills WHERE room_id = ? AND auto_activate = 1').all(roomId) as Record<string, unknown>[]
  const mapped = skills.map(mapSkillRow)
  const lower = contextText.toLowerCase()
  return mapped.filter(s => {
    if (!s.activationContext || s.activationContext.length === 0) return true
    return s.activationContext.some(keyword => lower.includes(keyword.toLowerCase()))
  })
}

// ─── Self-Mod Audit ─────────────────────────────────────────

function mapSelfModRow(row: Record<string, unknown>): SelfModAuditEntry {
  return {
    id: row.id as number,
    roomId: (row.room_id as number | null) ?? null,
    workerId: (row.worker_id as number | null) ?? null,
    filePath: row.file_path as string,
    oldHash: (row.old_hash as string | null) ?? null,
    newHash: (row.new_hash as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    reversible: (row.reversible as number) === 1,
    reverted: (row.reverted as number) === 1,
    createdAt: row.created_at as string
  }
}

export function getSelfModEntry(db: Database.Database, id: number): SelfModAuditEntry | null {
  const row = db.prepare('SELECT * FROM self_mod_audit WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapSelfModRow(row) : null
}

export function logSelfMod(
  db: Database.Database, roomId: number | null, workerId: number | null,
  filePath: string, oldHash: string | null, newHash: string | null,
  reason?: string, reversible: boolean = true
): SelfModAuditEntry {
  const result = db
    .prepare('INSERT INTO self_mod_audit (room_id, worker_id, file_path, old_hash, new_hash, reason, reversible) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(roomId, workerId, filePath, oldHash, newHash, reason ?? null, reversible ? 1 : 0)
  const row = db.prepare('SELECT * FROM self_mod_audit WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return mapSelfModRow(row)
}

function mapSelfModSnapshotRow(row: Record<string, unknown>): SelfModSnapshot {
  return {
    auditId: row.audit_id as number,
    targetType: row.target_type as string,
    targetId: (row.target_id as number | null) ?? null,
    oldContent: (row.old_content as string | null) ?? null,
    newContent: (row.new_content as string | null) ?? null
  }
}

export function saveSelfModSnapshot(
  db: Database.Database,
  auditId: number,
  targetType: string,
  targetId: number | null,
  oldContent: string | null,
  newContent: string | null
): void {
  db.prepare(
    `INSERT INTO self_mod_snapshots (audit_id, target_type, target_id, old_content, new_content)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(audit_id) DO UPDATE SET
       target_type = excluded.target_type,
       target_id = excluded.target_id,
       old_content = excluded.old_content,
       new_content = excluded.new_content`
  ).run(auditId, targetType, targetId, oldContent, newContent)
}

export function getSelfModSnapshot(db: Database.Database, auditId: number): SelfModSnapshot | null {
  const row = db
    .prepare('SELECT * FROM self_mod_snapshots WHERE audit_id = ?')
    .get(auditId) as Record<string, unknown> | undefined
  return row ? mapSelfModSnapshotRow(row) : null
}

export function getSelfModHistory(db: Database.Database, roomId: number, limit: number = 50): SelfModAuditEntry[] {
  const safeLimit = clampLimit(limit, 50, 500)
  const rows = db.prepare('SELECT * FROM self_mod_audit WHERE room_id = ? ORDER BY created_at DESC LIMIT ?').all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapSelfModRow)
}

export function markReverted(db: Database.Database, auditId: number): void {
  db.prepare('UPDATE self_mod_audit SET reverted = 1 WHERE id = ?').run(auditId)
}

// ─── Escalations ────────────────────────────────────────────

function mapEscalationRow(row: Record<string, unknown>): Escalation {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    fromAgentId: (row.from_agent_id as number | null) ?? null,
    toAgentId: (row.to_agent_id as number | null) ?? null,
    question: row.question as string,
    answer: (row.answer as string | null) ?? null,
    status: row.status as EscalationStatus,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null
  }
}

export function createEscalation(
  db: Database.Database, roomId: number, fromAgentId: number | null,
  question: string, toAgentId?: number
): Escalation {
  const result = db
    .prepare('INSERT INTO escalations (room_id, from_agent_id, to_agent_id, question) VALUES (?, ?, ?, ?)')
    .run(roomId, fromAgentId, toAgentId ?? null, question)
  return getEscalation(db, result.lastInsertRowid as number)!
}

export function getEscalation(db: Database.Database, id: number): Escalation | null {
  const row = db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapEscalationRow(row) : null
}

export function getPendingEscalations(db: Database.Database, roomId: number, toAgentId?: number): Escalation[] {
  if (toAgentId != null) {
    const rows = db.prepare("SELECT * FROM escalations WHERE room_id = ? AND status = 'pending' AND (to_agent_id = ? OR to_agent_id IS NULL) ORDER BY created_at ASC").all(roomId, toAgentId)
    return (rows as Record<string, unknown>[]).map(mapEscalationRow)
  }
  const rows = db.prepare("SELECT * FROM escalations WHERE room_id = ? AND status = 'pending' ORDER BY created_at ASC").all(roomId)
  return (rows as Record<string, unknown>[]).map(mapEscalationRow)
}

export function listEscalations(db: Database.Database, roomId: number, status?: EscalationStatus): Escalation[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM escalations WHERE room_id = ? AND status = ? ORDER BY created_at ASC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapEscalationRow)
  }
  const rows = db.prepare('SELECT * FROM escalations WHERE room_id = ? ORDER BY created_at ASC').all(roomId)
  return (rows as Record<string, unknown>[]).map(mapEscalationRow)
}

export function resolveEscalation(db: Database.Database, id: number, answer: string): void {
  db.prepare("UPDATE escalations SET answer = ?, status = 'resolved', resolved_at = datetime('now','localtime') WHERE id = ?")
    .run(answer, id)
}

export function getRecentKeeperAnswers(db: Database.Database, roomId: number, fromAgentId: number, limit: number = 5): Escalation[] {
  const rows = db.prepare(
    `SELECT * FROM escalations WHERE room_id = ? AND from_agent_id = ? AND status = 'resolved' AND to_agent_id IS NULL ORDER BY resolved_at DESC LIMIT ?`
  ).all(roomId, fromAgentId, limit)
  return (rows as Record<string, unknown>[]).map(mapEscalationRow)
}

// ─── Credentials ────────────────────────────────────────────

function mapCredentialRow(row: Record<string, unknown>): Credential {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    name: row.name as string,
    type: row.type as Credential['type'],
    valueEncrypted: row.value_encrypted as string,
    providedBy: row.provided_by as string,
    createdAt: row.created_at as string
  }
}

export function createCredential(
  db: Database.Database, roomId: number, name: string, type: string, value: string
): Credential {
  const encryptedValue = encryptSecret(value)
  db.prepare(`
      INSERT INTO credentials (room_id, name, type, value_encrypted)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, name) DO UPDATE SET
        type = excluded.type,
        value_encrypted = excluded.value_encrypted
    `)
    .run(roomId, name, type, encryptedValue)
  return getCredentialByName(db, roomId, name)!
}

export function getCredential(db: Database.Database, id: number): Credential | null {
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const credential = mapCredentialRow(row)
  try {
    return { ...credential, valueEncrypted: decryptSecret(credential.valueEncrypted) }
  } catch {
    // Keep credentials readable even if secret key changed.
    return credential
  }
}

export function listCredentials(db: Database.Database, roomId: number): Credential[] {
  const rows = db.prepare('SELECT id, room_id, name, type, provided_by, created_at FROM credentials WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
  return (rows as Record<string, unknown>[]).map(row => ({
    id: row.id as number,
    roomId: row.room_id as number,
    name: row.name as string,
    type: row.type as Credential['type'],
    valueEncrypted: '***',
    providedBy: row.provided_by as string,
    createdAt: row.created_at as string
  }))
}

export function deleteCredential(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
}

export function getCredentialByName(db: Database.Database, roomId: number, name: string): Credential | null {
  const row = db.prepare('SELECT * FROM credentials WHERE room_id = ? AND name = ?').get(roomId, name) as Record<string, unknown> | undefined
  if (!row) return null
  const credential = mapCredentialRow(row)
  try {
    return { ...credential, valueEncrypted: decryptSecret(credential.valueEncrypted) }
  } catch {
    // Keep credentials readable even if secret key changed.
    return credential
  }
}

// ─── Room Workers ───────────────────────────────────────────

export function listRoomWorkers(db: Database.Database, roomId: number): Worker[] {
  const rows = db.prepare('SELECT * FROM workers WHERE room_id = ? ORDER BY name ASC').all(roomId)
  return (rows as Record<string, unknown>[]).map(mapWorkerRow)
}

export function updateAgentState(db: Database.Database, workerId: number, state: string): void {
  db.prepare("UPDATE workers SET agent_state = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(state, workerId)
}

// ─── Wallets ────────────────────────────────────────────────

function mapWalletRow(row: Record<string, unknown>): Wallet {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    address: row.address as string,
    privateKeyEncrypted: row.private_key_encrypted as string,
    chain: row.chain as string,
    erc8004AgentId: (row.erc8004_agent_id as string | null) ?? null,
    createdAt: row.created_at as string
  }
}

export function updateWalletAgentId(db: Database.Database, walletId: number, agentId: string): void {
  db.prepare('UPDATE wallets SET erc8004_agent_id = ? WHERE id = ?').run(agentId, walletId)
}

export function createWallet(
  db: Database.Database, roomId: number, address: string, privateKeyEncrypted: string, chain: string = 'base'
): Wallet {
  const result = db
    .prepare('INSERT INTO wallets (room_id, address, private_key_encrypted, chain) VALUES (?, ?, ?, ?)')
    .run(roomId, address, privateKeyEncrypted, chain)
  return getWallet(db, result.lastInsertRowid as number)!
}

export function getWallet(db: Database.Database, id: number): Wallet | null {
  const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapWalletRow(row) : null
}

export function getWalletByRoom(db: Database.Database, roomId: number): Wallet | null {
  const row = db.prepare('SELECT * FROM wallets WHERE room_id = ?').get(roomId) as Record<string, unknown> | undefined
  return row ? mapWalletRow(row) : null
}

export function listWallets(db: Database.Database): Wallet[] {
  const rows = db.prepare('SELECT * FROM wallets ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(mapWalletRow)
}

export function deleteWallet(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM wallets WHERE id = ?').run(id)
}

// ─── Wallet Transactions ────────────────────────────────────

function mapWalletTransactionRow(row: Record<string, unknown>): WalletTransaction {
  return {
    id: row.id as number,
    walletId: row.wallet_id as number,
    type: row.type as WalletTransactionType,
    amount: row.amount as string,
    counterparty: row.counterparty as string | null,
    txHash: row.tx_hash as string | null,
    description: row.description as string | null,
    status: row.status as string,
    category: (row.category as WalletTransaction['category']) ?? null,
    createdAt: row.created_at as string
  }
}

export function logWalletTransaction(
  db: Database.Database, walletId: number, type: string, amount: string,
  opts?: { counterparty?: string; txHash?: string; description?: string; status?: string; category?: string }
): WalletTransaction {
  const result = db
    .prepare('INSERT INTO wallet_transactions (wallet_id, type, amount, counterparty, tx_hash, description, status, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(walletId, type, amount, opts?.counterparty ?? null, opts?.txHash ?? null, opts?.description ?? null, opts?.status ?? 'confirmed', opts?.category ?? null)
  return getWalletTransaction(db, result.lastInsertRowid as number)!
}

export function getWalletTransaction(db: Database.Database, id: number): WalletTransaction | null {
  const row = db.prepare('SELECT * FROM wallet_transactions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapWalletTransactionRow(row) : null
}

export function listWalletTransactions(db: Database.Database, walletId: number, limit: number = 50): WalletTransaction[] {
  const safeLimit = clampLimit(limit, 50, 500)
  const rows = db.prepare('SELECT * FROM wallet_transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?').all(walletId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapWalletTransactionRow)
}

export function getWalletTransactionSummary(db: Database.Database, walletId: number): { received: string; sent: string } {
  const received = db.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('receive', 'fund')"
  ).get(walletId) as { total: number }
  const sent = db.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('send', 'purchase')"
  ).get(walletId) as { total: number }
  return { received: received.total.toString(), sent: sent.total.toString() }
}

// ─── Stations ───────────────────────────────────────────────

function mapStationRow(row: Record<string, unknown>): Station {
  let config: Record<string, unknown> | null = null
  if (row.config && typeof row.config === 'string') {
    try { config = JSON.parse(row.config) } catch { /* ignore */ }
  }
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    name: row.name as string,
    provider: row.provider as StationProvider,
    externalId: row.external_id as string | null,
    tier: row.tier as StationTier,
    region: row.region as string | null,
    status: row.status as StationStatus,
    monthlyCost: row.monthly_cost as number,
    config,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function createStation(
  db: Database.Database, roomId: number, name: string, provider: string, tier: string,
  opts?: { externalId?: string; region?: string; monthlyCost?: number; config?: Record<string, unknown>; status?: string }
): Station {
  const result = db
    .prepare('INSERT INTO stations (room_id, name, provider, tier, external_id, region, monthly_cost, config, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      roomId, name, provider, tier,
      opts?.externalId ?? null,
      opts?.region ?? null,
      opts?.monthlyCost ?? 0,
      opts?.config ? JSON.stringify(opts.config) : null,
      opts?.status ?? 'provisioning'
    )
  return getStation(db, result.lastInsertRowid as number)!
}

export function getStation(db: Database.Database, id: number): Station | null {
  const row = db.prepare('SELECT * FROM stations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapStationRow(row) : null
}

export function listStations(db: Database.Database, roomId?: number, status?: string): Station[] {
  if (roomId && status) {
    const rows = db.prepare('SELECT * FROM stations WHERE room_id = ? AND status = ? ORDER BY created_at DESC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapStationRow)
  }
  if (roomId) {
    const rows = db.prepare('SELECT * FROM stations WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
    return (rows as Record<string, unknown>[]).map(mapStationRow)
  }
  if (status) {
    const rows = db.prepare('SELECT * FROM stations WHERE status = ? ORDER BY created_at DESC').all(status)
    return (rows as Record<string, unknown>[]).map(mapStationRow)
  }
  const rows = db.prepare('SELECT * FROM stations ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(mapStationRow)
}

export function updateStation(
  db: Database.Database, id: number,
  updates: { externalId?: string; status?: string; monthlyCost?: number; config?: Record<string, unknown> }
): Station {
  const parts: string[] = []
  const values: unknown[] = []
  if (updates.externalId !== undefined) { parts.push('external_id = ?'); values.push(updates.externalId) }
  if (updates.status !== undefined) { parts.push('status = ?'); values.push(updates.status) }
  if (updates.monthlyCost !== undefined) { parts.push('monthly_cost = ?'); values.push(updates.monthlyCost) }
  if (updates.config !== undefined) { parts.push('config = ?'); values.push(JSON.stringify(updates.config)) }
  if (parts.length === 0) return getStation(db, id)!
  parts.push("updated_at = datetime('now','localtime')")
  values.push(id)
  db.prepare(`UPDATE stations SET ${parts.join(', ')} WHERE id = ?`).run(...values)
  return getStation(db, id)!
}

export function deleteStation(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM stations WHERE id = ?').run(id)
}

// ─── Chat Messages ──────────────────────────────────────────

function mapChatMessageRow(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    createdAt: row.created_at as string
  }
}

export function insertChatMessage(db: Database.Database, roomId: number, role: 'user' | 'assistant', content: string): ChatMessage {
  const result = db
    .prepare('INSERT INTO chat_messages (room_id, role, content) VALUES (?, ?, ?)')
    .run(roomId, role, content)
  const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid as number) as Record<string, unknown>
  return mapChatMessageRow(row)
}

export function listChatMessages(db: Database.Database, roomId: number, limit: number = 100): ChatMessage[] {
  const safeLimit = clampLimit(limit, 100, 1000)
  const rows = db.prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY created_at ASC LIMIT ?').all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapChatMessageRow)
}

export function clearChatMessages(db: Database.Database, roomId: number): void {
  db.prepare('DELETE FROM chat_messages WHERE room_id = ?').run(roomId)
}

export function setChatSessionId(db: Database.Database, roomId: number, sessionId: string): void {
  db.prepare('UPDATE rooms SET chat_session_id = ? WHERE id = ?').run(sessionId, roomId)
}

export function clearChatSession(db: Database.Database, roomId: number): void {
  db.prepare('UPDATE rooms SET chat_session_id = NULL WHERE id = ?').run(roomId)
  clearChatMessages(db, roomId)
}

// ─── Revenue ────────────────────────────────────────────────

export function getRevenueSummary(db: Database.Database, roomId: number): RevenueSummary {
  const wallet = getWalletByRoom(db, roomId)
  if (!wallet) return { totalIncome: 0, totalExpenses: 0, netProfit: 0, stationCosts: 0, transactionCount: 0 }

  const income = db.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('receive', 'fund')"
  ).get(wallet.id) as { total: number }

  const expenses = db.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('send', 'purchase')"
  ).get(wallet.id) as { total: number }

  const stationCosts = db.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND category = 'station_cost'"
  ).get(wallet.id) as { total: number }

  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM wallet_transactions WHERE wallet_id = ?'
  ).get(wallet.id) as { cnt: number }

  return {
    totalIncome: income.total,
    totalExpenses: expenses.total,
    netProfit: income.total - expenses.total,
    stationCosts: stationCosts.total,
    transactionCount: count.cnt
  }
}

// ─── Room Messages (inter-room) ─────────────────────────────

function mapRoomMessageRow(row: Record<string, unknown>): RoomMessage {
  return {
    id: row.id as number,
    roomId: row.room_id as number,
    direction: row.direction as RoomMessage['direction'],
    fromRoomId: row.from_room_id as string | null,
    toRoomId: row.to_room_id as string | null,
    subject: row.subject as string,
    body: row.body as string,
    status: row.status as RoomMessage['status'],
    createdAt: row.created_at as string
  }
}

export function createRoomMessage(
  db: Database.Database, roomId: number, direction: string, subject: string, body: string,
  opts?: { fromRoomId?: string; toRoomId?: string }
): RoomMessage {
  const result = db
    .prepare('INSERT INTO room_messages (room_id, direction, from_room_id, to_room_id, subject, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(roomId, direction, opts?.fromRoomId ?? null, opts?.toRoomId ?? null, subject, body)
  return getRoomMessage(db, result.lastInsertRowid as number)!
}

export function getRoomMessage(db: Database.Database, id: number): RoomMessage | null {
  const row = db.prepare('SELECT * FROM room_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapRoomMessageRow(row) : null
}

export function listRoomMessages(db: Database.Database, roomId: number, status?: string): RoomMessage[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM room_messages WHERE room_id = ? AND status = ? ORDER BY created_at DESC').all(roomId, status)
    return (rows as Record<string, unknown>[]).map(mapRoomMessageRow)
  }
  const rows = db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
  return (rows as Record<string, unknown>[]).map(mapRoomMessageRow)
}

export function markRoomMessageRead(db: Database.Database, id: number): void {
  db.prepare("UPDATE room_messages SET status = 'read' WHERE id = ?").run(id)
}

export function markAllRoomMessagesRead(db: Database.Database, roomId: number): number {
  const result = db.prepare("UPDATE room_messages SET status = 'read' WHERE room_id = ? AND status = 'unread'").run(roomId)
  return result.changes
}

export function replyToRoomMessage(db: Database.Database, id: number): void {
  db.prepare("UPDATE room_messages SET status = 'replied' WHERE id = ?").run(id)
}

export function updateRoomMessageStatus(db: Database.Database, id: number, status: string): void {
  db.prepare('UPDATE room_messages SET status = ? WHERE id = ?').run(status, id)
}

export function deleteRoomMessage(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM room_messages WHERE id = ?').run(id)
}

// ─── Worker Cycles ──────────────────────────────────────────

function mapWorkerCycleRow(row: Record<string, unknown>): WorkerCycle {
  return {
    id: row.id as number,
    workerId: row.worker_id as number,
    roomId: row.room_id as number,
    model: row.model as string | null,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as string,
    errorMessage: row.error_message as string | null,
    durationMs: row.duration_ms as number | null,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
  }
}

function mapCycleLogRow(row: Record<string, unknown>): CycleLogEntry {
  return {
    id: row.id as number,
    cycleId: row.cycle_id as number,
    seq: row.seq as number,
    entryType: row.entry_type as string,
    content: row.content as string,
    createdAt: row.created_at as string,
  }
}

export function createWorkerCycle(db: Database.Database, workerId: number, roomId: number, model: string | null): WorkerCycle {
  const result = db.prepare(
    "INSERT INTO worker_cycles (worker_id, room_id, model) VALUES (?, ?, ?)"
  ).run(workerId, roomId, model)
  return getWorkerCycle(db, result.lastInsertRowid as number)!
}

export function getWorkerCycle(db: Database.Database, id: number): WorkerCycle | null {
  const row = db.prepare('SELECT * FROM worker_cycles WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapWorkerCycleRow(row) : null
}

export function completeWorkerCycle(
  db: Database.Database,
  cycleId: number,
  errorMessage?: string,
  usage?: { inputTokens: number; outputTokens: number }
): void {
  const cycle = getWorkerCycle(db, cycleId)
  if (!cycle) return
  const status = errorMessage ? 'failed' : 'completed'
  const durationMs = Date.now() - new Date(cycle.startedAt).getTime()
  db.prepare(
    "UPDATE worker_cycles SET finished_at = datetime('now','localtime'), status = ?, error_message = ?, duration_ms = ?, input_tokens = ?, output_tokens = ? WHERE id = ?"
  ).run(status, errorMessage ?? null, durationMs, usage?.inputTokens ?? null, usage?.outputTokens ?? null, cycleId)
}

export function listRoomCycles(db: Database.Database, roomId: number, limit: number = 20): WorkerCycle[] {
  const safeLimit = clampLimit(limit, 20, 200)
  const rows = db.prepare(
    'SELECT * FROM worker_cycles WHERE room_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapWorkerCycleRow)
}

/** Count productive tool calls in a worker's last N completed cycles.
 *  "Productive" = tools that change external state (web search, memory, goals, comms). */
export function countProductiveToolCalls(db: Database.Database, workerId: number, lastNCycles: number = 2): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM cycle_logs
    WHERE cycle_id IN (
      SELECT id FROM worker_cycles
      WHERE worker_id = ? AND status = 'completed'
      ORDER BY started_at DESC LIMIT ?
    )
    AND entry_type = 'tool_call'
    AND (content LIKE '%web_search%' OR content LIKE '%web_fetch%' OR content LIKE '%remember%'
      OR content LIKE '%send_message%' OR content LIKE '%inbox_send%'
      OR content LIKE '%update_progress%' OR content LIKE '%complete_goal%'
      OR content LIKE '%set_goal%' OR content LIKE '%delegate_task%' OR content LIKE '%propose%' OR content LIKE '%vote%')
  `).get(workerId, lastNCycles) as { cnt: number }
  return row.cnt
}

export function cleanupStaleCycles(db: Database.Database): number {
  const result = db.prepare(
    "UPDATE worker_cycles SET status = 'failed', error_message = 'Server restarted', finished_at = datetime('now','localtime') WHERE status = 'running'"
  ).run()
  return result.changes
}

export interface TokenUsageSummary {
  inputTokens: number
  outputTokens: number
  cycles: number
}

export function getRoomTokenUsage(db: Database.Database, roomId: number): TokenUsageSummary {
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens, COUNT(*) as cycles
     FROM worker_cycles WHERE room_id = ? AND status = 'completed' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`
  ).get(roomId) as { input_tokens: number; output_tokens: number; cycles: number }
  return { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cycles: row.cycles }
}

export function getRoomTokenUsageToday(db: Database.Database, roomId: number): TokenUsageSummary {
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens, COUNT(*) as cycles
     FROM worker_cycles WHERE room_id = ? AND status = 'completed' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
     AND started_at >= date('now','localtime')`
  ).get(roomId) as { input_tokens: number; output_tokens: number; cycles: number }
  return { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cycles: row.cycles }
}

export function insertCycleLogs(
  db: Database.Database,
  entries: Array<{ cycleId: number; seq: number; entryType: string; content: string }>
): void {
  const stmt = db.prepare(
    'INSERT INTO cycle_logs (cycle_id, seq, entry_type, content) VALUES (?, ?, ?, ?)'
  )
  const insertMany = db.transaction((items: typeof entries) => {
    for (const e of items) {
      stmt.run(e.cycleId, e.seq, e.entryType, e.content)
    }
  })
  insertMany(entries)
}

export function getCycleLogs(
  db: Database.Database,
  cycleId: number,
  afterSeq: number = 0,
  limit: number = 100
): CycleLogEntry[] {
  const safeAfterSeq = Number.isFinite(afterSeq) ? Math.max(0, Math.trunc(afterSeq)) : 0
  const safeLimit = clampLimit(limit, 100, 1000)
  const rows = db.prepare(
    'SELECT * FROM cycle_logs WHERE cycle_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(cycleId, safeAfterSeq, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapCycleLogRow)
}

const MAX_CYCLES_PER_WORKER = 50
const CYCLE_PRUNE_INTERVAL_MS = 5 * 60 * 1000
let lastCyclePruneTime = 0

export function pruneOldCycles(db: Database.Database): number {
  const now = Date.now()
  if (now - lastCyclePruneTime < CYCLE_PRUNE_INTERVAL_MS) return 0
  lastCyclePruneTime = now

  const staleIds = db.prepare(`
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY worker_id ORDER BY id DESC) AS rn
      FROM worker_cycles
    ) WHERE rn > ?
  `).all(MAX_CYCLES_PER_WORKER) as Array<{ id: number }>

  if (staleIds.length === 0) return 0

  const ids = staleIds.map(r => r.id)
  const placeholders = ids.map(() => '?').join(',')

  const deleteAll = db.transaction(() => {
    db.prepare(`DELETE FROM cycle_logs WHERE cycle_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM worker_cycles WHERE id IN (${placeholders})`).run(...ids)
  })
  deleteAll()
  return ids.length
}

// ─── Recent resolved decisions (for queen context — don't repeat approved things) ──

export function listRecentDecisions(db: Database.Database, roomId: number, limit: number = 5): QuorumDecision[] {
  const safeLimit = clampLimit(limit, 5, 50)
  const rows = db.prepare(
    `SELECT * FROM quorum_decisions WHERE room_id = ? AND status != 'voting' ORDER BY created_at DESC LIMIT ?`
  ).all(roomId, safeLimit)
  return (rows as Record<string, unknown>[]).map(mapDecisionRow)
}

// ─── Agent session continuity (all model types) ──────────────────────────────
// Persists cross-cycle session state for every queen model:
//   - CLI models (claude/codex): session_id string for --resume
//   - API models (openai/anthropic): messages_json conversation turns array

export function getAgentSession(
  db: Database.Database,
  workerId: number
): { sessionId: string | null; messagesJson: string | null; model: string; turnCount: number; updatedAt: string } | undefined {
  const row = db.prepare(
    'SELECT session_id, messages_json, model, turn_count, updated_at FROM agent_sessions WHERE worker_id = ?'
  ).get(workerId) as { session_id: string | null; messages_json: string | null; model: string; turn_count: number; updated_at: string } | undefined
  if (!row) return undefined
  return {
    sessionId: row.session_id,
    messagesJson: row.messages_json,
    model: row.model,
    turnCount: row.turn_count,
    updatedAt: row.updated_at
  }
}

export function saveAgentSession(
  db: Database.Database,
  workerId: number,
  opts: { sessionId?: string | null; messagesJson?: string | null; model: string }
): void {
  db.prepare(
    `INSERT INTO agent_sessions (worker_id, session_id, messages_json, model, turn_count, updated_at)
     VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))
     ON CONFLICT(worker_id) DO UPDATE SET
       session_id = CASE WHEN ? IS NOT NULL THEN ? ELSE session_id END,
       messages_json = CASE WHEN ? IS NOT NULL THEN ? ELSE messages_json END,
       model = ?,
       turn_count = turn_count + 1,
       updated_at = datetime('now','localtime')`
  ).run(
    workerId,
    opts.sessionId ?? null,
    opts.messagesJson ?? null,
    opts.model,
    opts.sessionId ?? null, opts.sessionId ?? null,
    opts.messagesJson ?? null, opts.messagesJson ?? null,
    opts.model
  )
}

export function deleteAgentSession(db: Database.Database, workerId: number): void {
  db.prepare('DELETE FROM agent_sessions WHERE worker_id = ?').run(workerId)
}
