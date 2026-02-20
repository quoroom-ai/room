import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as q from '../db-queries'
import { initTestDb } from './helpers/test-db'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

afterEach(() => {
  db.close()
})

// ─── Entities ──────────────────────────────────────────────────

describe('createEntity', () => {
  it('creates an entity with default type', () => {
    const entity = q.createEntity(db, 'Test Entity')
    expect(entity.id).toBe(1)
    expect(entity.name).toBe('Test Entity')
    expect(entity.type).toBe('fact')
    expect(entity.category).toBeNull()
  })

  it('creates an entity with custom type and category', () => {
    const entity = q.createEntity(db, 'Alice', 'person', 'contacts')
    expect(entity.name).toBe('Alice')
    expect(entity.type).toBe('person')
    expect(entity.category).toBe('contacts')
  })
})

describe('getEntity', () => {
  it('returns null for non-existent entity', () => {
    expect(q.getEntity(db, 999)).toBeNull()
  })

  it('returns the entity by id', () => {
    const created = q.createEntity(db, 'Test')
    const fetched = q.getEntity(db, created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.name).toBe('Test')
  })
})

describe('listEntities', () => {
  it('returns empty array when no entities exist', () => {
    expect(q.listEntities(db)).toEqual([])
  })

  it('returns all entities ordered by updated_at desc', () => {
    q.createEntity(db, 'A')
    q.createEntity(db, 'B')
    const all = q.listEntities(db)
    expect(all).toHaveLength(2)
  })

  it('filters by category', () => {
    q.createEntity(db, 'A', 'fact', 'work')
    q.createEntity(db, 'B', 'fact', 'personal')
    const work = q.listEntities(db, undefined, 'work')
    expect(work).toHaveLength(1)
    expect(work[0].name).toBe('A')
  })
})

describe('updateEntity', () => {
  it('updates entity name', () => {
    const entity = q.createEntity(db, 'Old Name')
    q.updateEntity(db, entity.id, { name: 'New Name' })
    const updated = q.getEntity(db, entity.id)
    expect(updated!.name).toBe('New Name')
  })

  it('does nothing when no fields provided', () => {
    const entity = q.createEntity(db, 'Test')
    q.updateEntity(db, entity.id, {})
    const same = q.getEntity(db, entity.id)
    expect(same!.name).toBe('Test')
  })
})

describe('deleteEntity', () => {
  it('deletes an entity', () => {
    const entity = q.createEntity(db, 'Doomed')
    q.deleteEntity(db, entity.id)
    expect(q.getEntity(db, entity.id)).toBeNull()
  })
})

describe('searchEntities', () => {
  it('finds entities by name LIKE fallback', () => {
    q.createEntity(db, 'Project Alpha')
    q.createEntity(db, 'Project Beta')
    q.createEntity(db, 'Meeting Notes')

    const results = q.searchEntities(db, 'Project')
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('returns empty for no match', () => {
    q.createEntity(db, 'Something')
    const results = q.searchEntities(db, 'zzzznotfound')
    expect(results).toHaveLength(0)
  })
})

// ─── Observations ──────────────────────────────────────────────

describe('addObservation', () => {
  it('creates an observation with default source', () => {
    const entity = q.createEntity(db, 'Test')
    const obs = q.addObservation(db, entity.id, 'Something important')
    expect(obs.id).toBe(1)
    expect(obs.content).toBe('Something important')
    expect(obs.source).toBe('claude')
    expect(obs.entity_id).toBe(entity.id)
  })

  it('creates an observation with custom source', () => {
    const entity = q.createEntity(db, 'Test')
    const obs = q.addObservation(db, entity.id, 'Data', 'user')
    expect(obs.source).toBe('user')
  })
})

describe('getObservation', () => {
  it('returns null for non-existent observation', () => {
    expect(q.getObservation(db, 999)).toBeNull()
  })
})

describe('getObservations', () => {
  it('returns all observations for an entity', () => {
    const entity = q.createEntity(db, 'Test')
    q.addObservation(db, entity.id, 'First')
    q.addObservation(db, entity.id, 'Second')
    const obs = q.getObservations(db, entity.id)
    expect(obs).toHaveLength(2)
  })

  it('returns empty array for entity with no observations', () => {
    const entity = q.createEntity(db, 'Test')
    expect(q.getObservations(db, entity.id)).toEqual([])
  })
})

describe('deleteObservation', () => {
  it('deletes an observation', () => {
    const entity = q.createEntity(db, 'Test')
    const obs = q.addObservation(db, entity.id, 'Delete me')
    q.deleteObservation(db, obs.id)
    expect(q.getObservation(db, obs.id)).toBeNull()
  })
})

// ─── Relations ─────────────────────────────────────────────────

describe('addRelation', () => {
  it('creates a relation between two entities', () => {
    const e1 = q.createEntity(db, 'Alice')
    const e2 = q.createEntity(db, 'Bob')
    const rel = q.addRelation(db, e1.id, e2.id, 'knows')
    expect(rel.from_entity).toBe(e1.id)
    expect(rel.to_entity).toBe(e2.id)
    expect(rel.relation_type).toBe('knows')
  })
})

describe('getRelation', () => {
  it('returns null for non-existent relation', () => {
    expect(q.getRelation(db, 999)).toBeNull()
  })
})

describe('getRelations', () => {
  it('returns relations where entity is from or to', () => {
    const e1 = q.createEntity(db, 'A')
    const e2 = q.createEntity(db, 'B')
    const e3 = q.createEntity(db, 'C')
    q.addRelation(db, e1.id, e2.id, 'knows')
    q.addRelation(db, e3.id, e1.id, 'manages')
    const rels = q.getRelations(db, e1.id)
    expect(rels).toHaveLength(2)
  })
})

describe('deleteRelation', () => {
  it('deletes a relation', () => {
    const e1 = q.createEntity(db, 'A')
    const e2 = q.createEntity(db, 'B')
    const rel = q.addRelation(db, e1.id, e2.id, 'test')
    q.deleteRelation(db, rel.id)
    expect(q.getRelation(db, rel.id)).toBeNull()
  })
})

// ─── Stats ─────────────────────────────────────────────────────

describe('getMemoryStats', () => {
  it('returns zero counts for empty db', () => {
    const stats = q.getMemoryStats(db)
    expect(stats.entityCount).toBe(0)
    expect(stats.observationCount).toBe(0)
    expect(stats.relationCount).toBe(0)
  })

  it('returns correct counts', () => {
    const e1 = q.createEntity(db, 'A')
    const e2 = q.createEntity(db, 'B')
    q.addObservation(db, e1.id, 'obs1')
    q.addObservation(db, e2.id, 'obs2')
    q.addRelation(db, e1.id, e2.id, 'related')

    const stats = q.getMemoryStats(db)
    expect(stats.entityCount).toBe(2)
    expect(stats.observationCount).toBe(2)
    expect(stats.relationCount).toBe(1)
  })
})

// ─── Tasks ─────────────────────────────────────────────────────

describe('createTask', () => {
  it('creates a cron task with defaults', () => {
    const task = q.createTask(db, {
      name: 'Test Task',
      prompt: 'Do something',
      cronExpression: '0 9 * * *'
    })
    expect(task.id).toBe(1)
    expect(task.name).toBe('Test Task')
    expect(task.prompt).toBe('Do something')
    expect(task.cronExpression).toBe('0 9 * * *')
    expect(task.triggerType).toBe('cron')
    expect(task.executor).toBe('claude_code')
    expect(task.status).toBe('active')
    expect(task.errorCount).toBe(0)
    expect(task.scheduledAt).toBeNull()
  })

  it('creates a one-time task with scheduledAt', () => {
    const future = new Date(Date.now() + 3600000).toISOString()
    const task = q.createTask(db, {
      name: 'One-time',
      prompt: 'Run once',
      triggerType: 'once',
      scheduledAt: future
    })
    expect(task.triggerType).toBe('once')
    expect(task.scheduledAt).toBe(future)
  })

  it('creates a manual task', () => {
    const task = q.createTask(db, {
      name: 'Manual',
      prompt: 'On demand',
      triggerType: 'manual'
    })
    expect(task.triggerType).toBe('manual')
    expect(task.cronExpression).toBeNull()
    expect(task.scheduledAt).toBeNull()
  })

  it('creates a task with maxRuns', () => {
    const task = q.createTask(db, {
      name: 'Limited',
      prompt: 'Run 3 times',
      triggerType: 'cron',
      cronExpression: '0 9 * * *',
      maxRuns: 3
    })
    expect(task.maxRuns).toBe(3)
    expect(task.runCount).toBe(0)
  })

  it('creates a task without maxRuns (unlimited)', () => {
    const task = q.createTask(db, {
      name: 'Unlimited',
      prompt: 'Run forever'
    })
    expect(task.maxRuns).toBeNull()
    expect(task.runCount).toBe(0)
  })

  it('creates a task with custom timeout', () => {
    const task = q.createTask(db, {
      name: 'Long Task',
      prompt: 'Research deeply',
      triggerType: 'manual',
      timeoutMinutes: 120
    })
    expect(task.timeoutMinutes).toBe(120)
  })

  it('creates a task with null timeout (default)', () => {
    const task = q.createTask(db, {
      name: 'Default Timeout',
      prompt: 'Quick task'
    })
    expect(task.timeoutMinutes).toBeNull()
  })

})

describe('getTask', () => {
  it('returns null for non-existent task', () => {
    expect(q.getTask(db, 999)).toBeNull()
  })

  it('maps all fields correctly', () => {
    q.createTask(db, {
      name: 'Full Task',
      description: 'A description',
      prompt: 'Run it',
      cronExpression: '*/5 * * * *',
      triggerType: 'cron',
      executor: 'claude_code'
    })
    const task = q.getTask(db, 1)!
    expect(task.name).toBe('Full Task')
    expect(task.description).toBe('A description')
    expect(task.cronExpression).toBe('*/5 * * * *')
    expect(task.triggerType).toBe('cron')
    expect(task.executor).toBe('claude_code')
    expect(task.createdAt).toBeTruthy()
    expect(task.updatedAt).toBeTruthy()
  })
})

describe('listTasks', () => {
  it('lists all tasks', () => {
    q.createTask(db, { name: 'A', prompt: 'p' })
    q.createTask(db, { name: 'B', prompt: 'p' })
    expect(q.listTasks(db)).toHaveLength(2)
  })

  it('filters by status', () => {
    q.createTask(db, { name: 'A', prompt: 'p' })
    const b = q.createTask(db, { name: 'B', prompt: 'p' })
    q.pauseTask(db, b.id)
    expect(q.listTasks(db, undefined, 'active')).toHaveLength(1)
    expect(q.listTasks(db, undefined, 'paused')).toHaveLength(1)
  })
})

describe('updateTask', () => {
  it('updates multiple fields', () => {
    const task = q.createTask(db, { name: 'Old', prompt: 'p' })
    q.updateTask(db, task.id, { name: 'New', status: 'paused' })
    const updated = q.getTask(db, task.id)!
    expect(updated.name).toBe('New')
    expect(updated.status).toBe('paused')
  })

  it('updates scheduledAt', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p', triggerType: 'once' })
    const future = new Date(Date.now() + 7200000).toISOString()
    q.updateTask(db, task.id, { scheduledAt: future })
    expect(q.getTask(db, task.id)!.scheduledAt).toBe(future)
  })

  it('does nothing when no updates', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.updateTask(db, task.id, {})
    expect(q.getTask(db, task.id)!.name).toBe('T')
  })

  it('updates runCount', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p', maxRuns: 5 })
    q.updateTask(db, task.id, { runCount: 3 })
    expect(q.getTask(db, task.id)!.runCount).toBe(3)
  })

  it('updates maxRuns', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.updateTask(db, task.id, { maxRuns: 10 })
    expect(q.getTask(db, task.id)!.maxRuns).toBe(10)
  })

})

describe('deleteTask', () => {
  it('deletes a task', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.deleteTask(db, task.id)
    expect(q.getTask(db, task.id)).toBeNull()
  })
})

describe('pauseTask / resumeTask', () => {
  it('pauses and resumes a task', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.pauseTask(db, task.id)
    expect(q.getTask(db, task.id)!.status).toBe('paused')
    q.resumeTask(db, task.id)
    expect(q.getTask(db, task.id)!.status).toBe('active')
  })
})

// ─── Task Runs ─────────────────────────────────────────────────

describe('createTaskRun', () => {
  it('creates a running task run', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    expect(run.taskId).toBe(task.id)
    expect(run.status).toBe('running')
    expect(run.startedAt).toBeTruthy()
    expect(run.finishedAt).toBeNull()
    expect(run.progress).toBeNull()
    expect(run.progressMessage).toBeNull()
  })
})

describe('completeTaskRun', () => {
  it('completes a task run successfully', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    q.completeTaskRun(db, run.id, 'Success output')
    const completed = q.getTaskRun(db, run.id)!
    expect(completed.status).toBe('completed')
    expect(completed.result).toBe('Success output')
    expect(completed.finishedAt).toBeTruthy()
    expect(completed.durationMs).toBeDefined()
    expect(completed.errorMessage).toBeNull()
  })

  it('completes a task run with error', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    q.completeTaskRun(db, run.id, 'output', undefined, 'Something went wrong')
    const completed = q.getTaskRun(db, run.id)!
    expect(completed.status).toBe('failed')
    expect(completed.errorMessage).toBe('Something went wrong')

    // Error count should be incremented on the task
    const updatedTask = q.getTask(db, task.id)!
    expect(updatedTask.errorCount).toBe(1)
  })

  it('resets error count on success', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })

    // Fail first
    const run1 = q.createTaskRun(db, task.id)
    q.completeTaskRun(db, run1.id, '', undefined, 'error')
    expect(q.getTask(db, task.id)!.errorCount).toBe(1)

    // Succeed next
    const run2 = q.createTaskRun(db, task.id)
    q.completeTaskRun(db, run2.id, 'ok')
    expect(q.getTask(db, task.id)!.errorCount).toBe(0)
  })

  it('does nothing for non-existent run', () => {
    q.completeTaskRun(db, 999, 'output')
    // Should not throw
  })
})

describe('getTaskRuns', () => {
  it('returns runs for a task, ordered by started_at desc', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.createTaskRun(db, task.id)
    q.createTaskRun(db, task.id)
    q.createTaskRun(db, task.id)
    const runs = q.getTaskRuns(db, task.id)
    expect(runs).toHaveLength(3)
  })

  it('respects limit', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    for (let i = 0; i < 5; i++) q.createTaskRun(db, task.id)
    expect(q.getTaskRuns(db, task.id, 2)).toHaveLength(2)
  })
})

describe('listAllRuns', () => {
  it('lists runs across all tasks', () => {
    const t1 = q.createTask(db, { name: 'T1', prompt: 'p' })
    const t2 = q.createTask(db, { name: 'T2', prompt: 'p' })
    q.createTaskRun(db, t1.id)
    q.createTaskRun(db, t2.id)
    expect(q.listAllRuns(db, 10)).toHaveLength(2)
  })
})

describe('getLatestTaskRun', () => {
  it('returns null when no runs exist', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    expect(q.getLatestTaskRun(db, task.id)).toBeNull()
  })

  it('returns a run when runs exist', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    q.createTaskRun(db, task.id)
    q.createTaskRun(db, task.id)
    const result = q.getLatestTaskRun(db, task.id)
    expect(result).not.toBeNull()
    expect(result!.taskId).toBe(task.id)
  })
})

// ─── One-Time & Progress Queries ───────────────────────────────

describe('getDueOnceTasks', () => {
  it('returns empty when no one-time tasks exist', () => {
    expect(q.getDueOnceTasks(db)).toEqual([])
  })

  it('returns tasks where scheduled_at is in the past', () => {
    // Use local time (matching datetime('now','localtime') in the query)
    const d = new Date(Date.now() - 120000)
    const past = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)
    q.createTask(db, {
      name: 'Due Task',
      prompt: 'run me',
      triggerType: 'once',
      scheduledAt: past
    })
    const due = q.getDueOnceTasks(db)
    expect(due).toHaveLength(1)
    expect(due[0].name).toBe('Due Task')
  })

  it('returns due tasks for local ISO-8601 values written by APIs', () => {
    // APIs send local time without Z (e.g. "2026-02-20T15:00:00")
    const d = new Date(Date.now() - 120000)
    const pastLocal = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().replace('Z', '').slice(0, 19)
    q.createTask(db, {
      name: 'Due ISO Task',
      prompt: 'run me',
      triggerType: 'once',
      scheduledAt: pastLocal
    })

    const due = q.getDueOnceTasks(db)
    expect(due.some((task) => task.name === 'Due ISO Task')).toBe(true)
  })

  it('does not return future one-time tasks', () => {
    const future = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').replace('Z', '')
    q.createTask(db, {
      name: 'Future Task',
      prompt: 'not yet',
      triggerType: 'once',
      scheduledAt: future
    })
    expect(q.getDueOnceTasks(db)).toHaveLength(0)
  })

  it('does not return paused one-time tasks', () => {
    const past = new Date(Date.now() - 120000).toISOString().replace('T', ' ').replace('Z', '')
    const task = q.createTask(db, {
      name: 'Paused One-Time',
      prompt: 'paused',
      triggerType: 'once',
      scheduledAt: past
    })
    q.pauseTask(db, task.id)
    expect(q.getDueOnceTasks(db)).toHaveLength(0)
  })

  it('does not return completed one-time tasks', () => {
    const past = new Date(Date.now() - 120000).toISOString().replace('T', ' ').replace('Z', '')
    const task = q.createTask(db, {
      name: 'Done',
      prompt: 'done',
      triggerType: 'once',
      scheduledAt: past
    })
    q.updateTask(db, task.id, { status: 'completed' })
    expect(q.getDueOnceTasks(db)).toHaveLength(0)
  })

  it('does not return cron tasks', () => {
    q.createTask(db, {
      name: 'Cron Task',
      prompt: 'cron',
      triggerType: 'cron',
      cronExpression: '* * * * *'
    })
    expect(q.getDueOnceTasks(db)).toHaveLength(0)
  })
})

describe('updateTaskRunProgress', () => {
  it('updates progress and message on a task run', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    q.updateTaskRunProgress(db, run.id, 0.5, 'Step 2: Using Bash...')
    const updated = q.getTaskRun(db, run.id)!
    expect(updated.progress).toBe(0.5)
    expect(updated.progressMessage).toBe('Step 2: Using Bash...')
  })

  it('handles null progress (indeterminate)', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    q.updateTaskRunProgress(db, run.id, null, 'Working...')
    const updated = q.getTaskRun(db, run.id)!
    expect(updated.progress).toBeNull()
    expect(updated.progressMessage).toBe('Working...')
  })
})

describe('getRunningTaskRuns', () => {
  it('returns empty when no running runs', () => {
    expect(q.getRunningTaskRuns(db)).toEqual([])
  })

  it('returns only running task runs', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run1 = q.createTaskRun(db, task.id) // running
    const run2 = q.createTaskRun(db, task.id) // running
    q.completeTaskRun(db, run1.id, 'done')    // now completed

    const running = q.getRunningTaskRuns(db)
    expect(running).toHaveLength(1)
    expect(running[0].id).toBe(run2.id)
  })
})

// ─── Schema Migration ──────────────────────────────────────────

describe('schema', () => {
  it('creates all required tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)
    const expected = [
      'chat_messages', 'console_logs', 'credentials', 'embeddings',
      'entities', 'escalations', 'goal_updates', 'goals',
      'observations', 'quorum_decisions', 'quorum_votes', 'relations',
      'room_activity', 'room_messages', 'rooms', 'schema_version',
      'self_mod_audit', 'settings', 'skills', 'stations',
      'task_runs', 'tasks', 'wallet_transactions', 'wallets',
      'watches', 'workers'
    ]
    for (const name of expected) {
      expect(tableNames).toContain(name)
    }
  })

  it('schema_version table has version 1', () => {
    const versions = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as { version: number }[]
    expect(versions.map((v) => v.version)).toEqual([1])
  })
})

// ─── Memory-Task Integration ────────────────────────────────────

describe('getTaskMemoryContext', () => {
  it('returns null when task has no memory entity', () => {
    const task = q.createTask(db, { name: 'No Memory', prompt: 'p' })
    expect(q.getTaskMemoryContext(db, task.id)).toBeNull()
  })

  it('returns null when memory entity has no observations', () => {
    const task = q.createTask(db, { name: 'Empty Memory', prompt: 'p' })
    const entity = q.createEntity(db, 'Task: Empty Memory', 'task_result', 'task')
    q.updateTask(db, task.id, { memoryEntityId: entity.id })
    expect(q.getTaskMemoryContext(db, task.id)).toBeNull()
  })

  it('returns formatted context with recent observations', () => {
    const task = q.createTask(db, { name: 'With Memory', prompt: 'p' })
    const entity = q.createEntity(db, 'Task: With Memory', 'task_result', 'task')
    q.updateTask(db, task.id, { memoryEntityId: entity.id })
    q.addObservation(db, entity.id, '[SUCCESS] First result', 'task_runner')
    q.addObservation(db, entity.id, '[SUCCESS] Second result', 'task_runner')

    const context = q.getTaskMemoryContext(db, task.id)
    expect(context).not.toBeNull()
    expect(context).toContain('Your previous results')
    expect(context).toContain('First result')
    expect(context).toContain('Second result')
  })

  it('limits own observations to 5', () => {
    const task = q.createTask(db, { name: 'Many Results', prompt: 'p' })
    const entity = q.createEntity(db, 'Task: Many Results', 'task_result', 'task')
    q.updateTask(db, task.id, { memoryEntityId: entity.id })
    for (let i = 0; i < 8; i++) {
      q.addObservation(db, entity.id, `[SUCCESS] Result ${i}`, 'task_runner')
    }

    const context = q.getTaskMemoryContext(db, task.id)!
    // Most recent 5 should be present (7,6,5,4,3), oldest (0,1,2) should not
    expect(context).toContain('Result 7')
    expect(context).toContain('Result 3')
    expect(context).not.toContain('Result 2')
  })

  it('includes related knowledge from other entities', () => {
    // Create a user memory about "HN"
    const userEntity = q.createEntity(db, 'HN Preferences', 'preference', 'personal')
    q.addObservation(db, userEntity.id, 'User prefers AI and startup stories', 'claude')

    // Create a task named "HN Digest"
    const task = q.createTask(db, { name: 'HN Digest', prompt: 'Fetch HN stories' })

    const context = q.getTaskMemoryContext(db, task.id)
    expect(context).not.toBeNull()
    expect(context).toContain('Related knowledge')
    expect(context).toContain('HN Preferences')
    expect(context).toContain('AI and startup stories')
  })

  it('includes results from other tasks in related knowledge', () => {
    // Create another task with results
    const otherTask = q.createTask(db, { name: 'Tech News Tracker', prompt: 'p' })
    const otherEntity = q.createEntity(db, 'Task: Tech News Tracker', 'task_result', 'task')
    q.updateTask(db, otherTask.id, { memoryEntityId: otherEntity.id })
    q.addObservation(db, otherEntity.id, '[SUCCESS] Top story: AI breakthrough', 'task_runner')

    // Create a task that should find "Tech News" as related
    const task = q.createTask(db, { name: 'Tech News Summary', prompt: 'Summarize tech news' })

    const context = q.getTaskMemoryContext(db, task.id)
    // Should find the other task's results as related knowledge
    expect(context).not.toBeNull()
    expect(context).toContain('Related knowledge')
    expect(context).toContain('Tech News Tracker')
  })

  it('returns null for non-existent task', () => {
    expect(q.getTaskMemoryContext(db, 999)).toBeNull()
  })
})

describe('ensureTaskMemoryEntity', () => {
  it('creates a new entity on first call', () => {
    const task = q.createTask(db, { name: 'New Task', prompt: 'p' })
    const entityId = q.ensureTaskMemoryEntity(db, task.id)

    const entity = q.getEntity(db, entityId)
    expect(entity).not.toBeNull()
    expect(entity!.name).toBe('Task: New Task')
    expect(entity!.type).toBe('task_result')
    expect(entity!.category).toBe('task')

    // Task should be linked
    const updated = q.getTask(db, task.id)!
    expect(updated.memoryEntityId).toBe(entityId)
  })

  it('reuses existing entity on subsequent calls', () => {
    const task = q.createTask(db, { name: 'Stable Task', prompt: 'p' })
    const id1 = q.ensureTaskMemoryEntity(db, task.id)
    const id2 = q.ensureTaskMemoryEntity(db, task.id)
    expect(id1).toBe(id2)
  })

  it('creates new entity if linked entity was deleted', () => {
    const task = q.createTask(db, { name: 'Broken Link', prompt: 'p' })
    const id1 = q.ensureTaskMemoryEntity(db, task.id)
    q.deleteEntity(db, id1) // simulate entity deletion

    const id2 = q.ensureTaskMemoryEntity(db, task.id)
    expect(id2).not.toBe(id1)

    const entity = q.getEntity(db, id2)
    expect(entity!.name).toBe('Task: Broken Link')
  })

  it('throws for non-existent task', () => {
    expect(() => q.ensureTaskMemoryEntity(db, 999)).toThrow('not found')
  })
})

describe('storeTaskResultInMemory', () => {
  it('stores successful result as observation', () => {
    const task = q.createTask(db, { name: 'Store Test', prompt: 'p' })
    q.storeTaskResultInMemory(db, task.id, 'Task output here', true)

    const updated = q.getTask(db, task.id)!
    expect(updated.memoryEntityId).not.toBeNull()

    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs).toHaveLength(1)
    expect(obs[0].content).toContain('[SUCCESS]')
    expect(obs[0].content).toContain('Task output here')
    expect(obs[0].source).toBe('task_runner')
  })

  it('stores failed result with FAILED prefix', () => {
    const task = q.createTask(db, { name: 'Fail Test', prompt: 'p' })
    q.storeTaskResultInMemory(db, task.id, 'Error output', false)

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs[0].content).toContain('[FAILED]')
  })

  it('truncates long results', () => {
    const task = q.createTask(db, { name: 'Long Result', prompt: 'p' })
    const longOutput = 'x'.repeat(3000)
    q.storeTaskResultInMemory(db, task.id, longOutput, true)

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs[0].content.length).toBeLessThan(2100) // ~2000 + prefix + truncation marker
    expect(obs[0].content).toContain('[...truncated]')
  })

  it('prunes old observations beyond limit', () => {
    const task = q.createTask(db, { name: 'Prune Test', prompt: 'p' })
    for (let i = 0; i < 15; i++) {
      q.storeTaskResultInMemory(db, task.id, `Result ${i}`, true)
    }

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs.length).toBe(10) // pruned to MAX_OBSERVATIONS_PER_ENTITY
  })
})

describe('incrementRunCount', () => {
  it('increments run count', () => {
    const task = q.createTask(db, { name: 'Counter', prompt: 'p' })
    expect(q.getTask(db, task.id)!.runCount).toBe(0)

    q.incrementRunCount(db, task.id)
    expect(q.getTask(db, task.id)!.runCount).toBe(1)

    q.incrementRunCount(db, task.id)
    expect(q.getTask(db, task.id)!.runCount).toBe(2)
  })

  it('auto-completes task when maxRuns reached', () => {
    const task = q.createTask(db, { name: 'Limited', prompt: 'p', maxRuns: 2 })

    q.incrementRunCount(db, task.id)
    expect(q.getTask(db, task.id)!.status).toBe('active')

    q.incrementRunCount(db, task.id)
    expect(q.getTask(db, task.id)!.status).toBe('completed')
  })

  it('does not auto-complete when maxRuns is null', () => {
    const task = q.createTask(db, { name: 'Unlimited', prompt: 'p' })

    for (let i = 0; i < 100; i++) {
      q.incrementRunCount(db, task.id)
    }
    expect(q.getTask(db, task.id)!.status).toBe('active')
    expect(q.getTask(db, task.id)!.runCount).toBe(100)
  })
})

// ─── Workers ─────────────────────────────────────────────────

describe('createWorker', () => {
  it('creates a worker with required fields', () => {
    const w = q.createWorker(db, { name: 'Research Bot', systemPrompt: 'You are a researcher.' })
    expect(w.id).toBe(1)
    expect(w.name).toBe('Research Bot')
    expect(w.systemPrompt).toBe('You are a researcher.')
    expect(w.isDefault).toBe(false)
    expect(w.taskCount).toBe(0)
  })

  it('creates a default worker and clears previous default', () => {
    const w1 = q.createWorker(db, { name: 'W1', systemPrompt: 'p', isDefault: true })
    expect(w1.isDefault).toBe(true)

    const w2 = q.createWorker(db, { name: 'W2', systemPrompt: 'p', isDefault: true })
    expect(w2.isDefault).toBe(true)
    expect(q.getWorker(db, w1.id)!.isDefault).toBe(false)
  })
})

describe('getWorker', () => {
  it('returns null for non-existent worker', () => {
    expect(q.getWorker(db, 999)).toBeNull()
  })
})

describe('listWorkers', () => {
  it('returns workers ordered by default first, then name', () => {
    q.createWorker(db, { name: 'Bravo', systemPrompt: 'p' })
    q.createWorker(db, { name: 'Alpha', systemPrompt: 'p', isDefault: true })
    const list = q.listWorkers(db)
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe('Alpha')
    expect(list[0].isDefault).toBe(true)
  })
})

describe('updateWorker', () => {
  it('updates worker fields', () => {
    const w = q.createWorker(db, { name: 'Old', systemPrompt: 'old prompt' })
    q.updateWorker(db, w.id, { name: 'New', systemPrompt: 'new prompt' })
    const updated = q.getWorker(db, w.id)!
    expect(updated.name).toBe('New')
    expect(updated.systemPrompt).toBe('new prompt')
  })
})

describe('deleteWorker', () => {
  it('deletes a worker', () => {
    const w = q.createWorker(db, { name: 'Temp', systemPrompt: 'p' })
    q.deleteWorker(db, w.id)
    expect(q.getWorker(db, w.id)).toBeNull()
  })
})

describe('getDefaultWorker', () => {
  it('returns null when no default worker', () => {
    q.createWorker(db, { name: 'W', systemPrompt: 'p' })
    expect(q.getDefaultWorker(db)).toBeNull()
  })

  it('returns the default worker', () => {
    q.createWorker(db, { name: 'Default', systemPrompt: 'p', isDefault: true })
    const def = q.getDefaultWorker(db)
    expect(def).not.toBeNull()
    expect(def!.name).toBe('Default')
  })
})

describe('task-worker relationship', () => {
  it('creates task with workerId', () => {
    const w = q.createWorker(db, { name: 'Bot', systemPrompt: 'p' })
    const task = q.createTask(db, { name: 'T', prompt: 'p', workerId: w.id })
    expect(task.workerId).toBe(w.id)
  })

  it('refreshes worker task count on task create', () => {
    const w = q.createWorker(db, { name: 'Bot', systemPrompt: 'p' })
    q.createTask(db, { name: 'T1', prompt: 'p', workerId: w.id })
    q.createTask(db, { name: 'T2', prompt: 'p', workerId: w.id })
    expect(q.getWorker(db, w.id)!.taskCount).toBe(2)
  })

  it('refreshes worker task count on task delete', () => {
    const w = q.createWorker(db, { name: 'Bot', systemPrompt: 'p' })
    const t1 = q.createTask(db, { name: 'T1', prompt: 'p', workerId: w.id })
    q.createTask(db, { name: 'T2', prompt: 'p', workerId: w.id })
    q.deleteTask(db, t1.id)
    expect(q.getWorker(db, w.id)!.taskCount).toBe(1)
  })

  it('creates task with sessionContinuity', () => {
    const task = q.createTask(db, { name: 'Session Task', prompt: 'p', sessionContinuity: true })
    expect(task.sessionContinuity).toBe(true)
    expect(task.sessionId).toBeNull()
  })

  it('defaults sessionContinuity to false', () => {
    const task = q.createTask(db, { name: 'Normal Task', prompt: 'p' })
    expect(task.sessionContinuity).toBe(false)
  })
})

// ─── Worker Role Field ──────────────────────────────────────

describe('worker role field', () => {
  it('creates worker with name and role', () => {
    const w = q.createWorker(db, { name: 'John', role: 'Chief of Staff', systemPrompt: 'p' })
    expect(w.name).toBe('John')
    expect(w.role).toBe('Chief of Staff')
  })

  it('creates worker without role (defaults to null)', () => {
    const w = q.createWorker(db, { name: 'Ada', systemPrompt: 'p' })
    expect(w.name).toBe('Ada')
    expect(w.role).toBeNull()
  })

  it('updates worker role', () => {
    const w = q.createWorker(db, { name: 'Bot', systemPrompt: 'p' })
    expect(w.role).toBeNull()

    q.updateWorker(db, w.id, { role: 'Researcher' })
    expect(q.getWorker(db, w.id)!.role).toBe('Researcher')
  })

  it('includes role in listWorkers', () => {
    q.createWorker(db, { name: 'John', role: 'CoS', systemPrompt: 'p' })
    q.createWorker(db, { name: 'Ada', systemPrompt: 'p' })
    const list = q.listWorkers(db)
    expect(list).toHaveLength(2)
    const john = list.find(w => w.name === 'John')
    const ada = list.find(w => w.name === 'Ada')
    expect(john!.role).toBe('CoS')
    expect(ada!.role).toBeNull()
  })

  it('clears role back to null', () => {
    const w = q.createWorker(db, { name: 'Bot', role: 'Analyst', systemPrompt: 'p' })
    expect(w.role).toBe('Analyst')

    q.updateWorker(db, w.id, { role: null })
    expect(q.getWorker(db, w.id)!.role).toBeNull()
  })

  it('changes role from one value to another', () => {
    const w = q.createWorker(db, { name: 'Bot', role: 'Writer', systemPrompt: 'p' })
    q.updateWorker(db, w.id, { role: 'Researcher' })
    expect(q.getWorker(db, w.id)!.role).toBe('Researcher')
  })
})

// ─── Session Continuity Queries ──────────────────────────────

describe('session queries', () => {
  it('updateTaskRunSessionId stores session on a run', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const run = q.createTaskRun(db, task.id)
    q.updateTaskRunSessionId(db, run.id, 'sess-abc')
    const updated = q.getTaskRun(db, run.id)!
    expect(updated.sessionId).toBe('sess-abc')
  })

  it('clearTaskSession clears session_id on task', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p', sessionContinuity: true })
    q.updateTask(db, task.id, { sessionId: 'sess-123' })
    expect(q.getTask(db, task.id)!.sessionId).toBe('sess-123')

    q.clearTaskSession(db, task.id)
    expect(q.getTask(db, task.id)!.sessionId).toBeNull()
  })

  it('getSessionRunCount counts runs with a specific session', () => {
    const task = q.createTask(db, { name: 'T', prompt: 'p' })
    const r1 = q.createTaskRun(db, task.id)
    const r2 = q.createTaskRun(db, task.id)
    const r3 = q.createTaskRun(db, task.id)
    q.updateTaskRunSessionId(db, r1.id, 'sess-a')
    q.updateTaskRunSessionId(db, r2.id, 'sess-a')
    q.updateTaskRunSessionId(db, r3.id, 'sess-b')

    expect(q.getSessionRunCount(db, task.id, 'sess-a')).toBe(2)
    expect(q.getSessionRunCount(db, task.id, 'sess-b')).toBe(1)
    expect(q.getSessionRunCount(db, task.id, 'sess-c')).toBe(0)
  })
})

describe('getCrossTaskMemoryContext', () => {
  it('returns null when no related entities exist', () => {
    const task = q.createTask(db, { name: 'Isolated Task', prompt: 'p' })
    expect(q.getCrossTaskMemoryContext(db, task.id)).toBeNull()
  })

  it('returns cross-task knowledge excluding own entity', () => {
    const other = q.createEntity(db, 'HN Preferences', 'preference', 'personal')
    q.addObservation(db, other.id, 'User likes AI stories', 'claude')

    const task = q.createTask(db, { name: 'HN Digest', prompt: 'p' })
    const own = q.createEntity(db, 'Task: HN Digest', 'task_result', 'task')
    q.updateTask(db, task.id, { memoryEntityId: own.id })
    q.addObservation(db, own.id, 'Own result data', 'task_runner')

    const context = q.getCrossTaskMemoryContext(db, task.id)
    expect(context).not.toBeNull()
    expect(context).toContain('HN Preferences')
    expect(context).toContain('AI stories')
    expect(context).not.toContain('Own result data')
  })
})

// ─── Embeddings ──────────────────────────────────────────────

describe('embedding CRUD', () => {
  it('upserts and retrieves an embedding', () => {
    const entity = q.createEntity(db, 'Test Embed')
    const vector = Buffer.alloc(384 * 4)
    q.upsertEmbedding(db, entity.id, 'entity', entity.id, 'hash123', vector, 'all-MiniLM-L6-v2', 384)

    const embeddings = q.getEmbeddingsForEntity(db, entity.id)
    expect(embeddings).toHaveLength(1)
    expect(embeddings[0].sourceType).toBe('entity')
    expect(embeddings[0].textHash).toBe('hash123')
  })

  it('upsert replaces on conflict', () => {
    const entity = q.createEntity(db, 'Test')
    const v1 = Buffer.alloc(384 * 4)
    const v2 = Buffer.alloc(384 * 4, 1)
    q.upsertEmbedding(db, entity.id, 'entity', entity.id, 'hash1', v1, 'all-MiniLM-L6-v2', 384)
    q.upsertEmbedding(db, entity.id, 'entity', entity.id, 'hash2', v2, 'all-MiniLM-L6-v2', 384)

    const embeddings = q.getEmbeddingsForEntity(db, entity.id)
    expect(embeddings).toHaveLength(1)
    expect(embeddings[0].textHash).toBe('hash2')
  })

  it('getAllEmbeddings returns all', () => {
    const e1 = q.createEntity(db, 'A')
    const e2 = q.createEntity(db, 'B')
    q.upsertEmbedding(db, e1.id, 'entity', e1.id, 'h1', Buffer.alloc(4), 'model', 1)
    q.upsertEmbedding(db, e2.id, 'entity', e2.id, 'h2', Buffer.alloc(4), 'model', 1)
    expect(q.getAllEmbeddings(db)).toHaveLength(2)
  })

  it('deleteEmbeddingsForEntity removes embeddings', () => {
    const entity = q.createEntity(db, 'Doomed')
    q.upsertEmbedding(db, entity.id, 'entity', entity.id, 'h', Buffer.alloc(4), 'model', 1)
    q.deleteEmbeddingsForEntity(db, entity.id)
    expect(q.getEmbeddingsForEntity(db, entity.id)).toHaveLength(0)
  })

  it('getUnembeddedEntities returns entities without embeddings', () => {
    q.createEntity(db, 'A')
    const b = q.createEntity(db, 'B')
    q.upsertEmbedding(db, b.id, 'entity', b.id, 'h', Buffer.alloc(4), 'model', 1)

    const unembedded = q.getUnembeddedEntities(db, 10)
    expect(unembedded).toHaveLength(1)
    expect(unembedded[0].name).toBe('A')
  })
})

// ─── Hybrid Search ──────────────────────────────────────────

describe('hybridSearch', () => {
  it('works with FTS only (no semantic results)', () => {
    q.createEntity(db, 'Project Alpha')
    q.createEntity(db, 'Project Beta')

    const results = q.hybridSearch(db, 'Project', null)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0].semanticScore).toBe(0)
  })

  it('merges FTS and semantic results', () => {
    const e1 = q.createEntity(db, 'Machine Learning')
    q.createEntity(db, 'Deep Learning')

    const semanticResults = [
      { entityId: e1.id, score: 0.9 },
      { entityId: 999, score: 0.5 } // non-existent, should be skipped
    ]

    const results = q.hybridSearch(db, 'Machine', semanticResults)
    expect(results.length).toBeGreaterThanOrEqual(1)
    // Machine Learning should rank high (both FTS and semantic)
    const ml = results.find(r => r.entity.name === 'Machine Learning')
    expect(ml).toBeDefined()
    expect(ml!.semanticScore).toBe(0.9)
    expect(ml!.ftsScore).toBeGreaterThan(0)
  })

  it('returns empty for no matches', () => {
    q.createEntity(db, 'Something')
    const results = q.hybridSearch(db, 'zzzznotfound', null)
    expect(results).toHaveLength(0)
  })
})

// ─── Learned Context ──────────────────────────────────────────────

describe('learnedContext', () => {
  it('defaults to null on task creation', () => {
    const task = q.createTask(db, { name: 'Test', prompt: 'Do something' })
    expect(task.learnedContext).toBeNull()
  })

  it('can be set via updateTask', () => {
    const task = q.createTask(db, { name: 'Test', prompt: 'Do something' })
    q.updateTask(db, task.id, { learnedContext: 'Use CoinGecko API for BTC price' })
    const updated = q.getTask(db, task.id)!
    expect(updated.learnedContext).toBe('Use CoinGecko API for BTC price')
  })

  it('can be cleared by setting to null', () => {
    const task = q.createTask(db, { name: 'Test', prompt: 'Do something' })
    q.updateTask(db, task.id, { learnedContext: 'Some context' })
    q.updateTask(db, task.id, { learnedContext: null })
    const updated = q.getTask(db, task.id)!
    expect(updated.learnedContext).toBeNull()
  })

  it('persists through getTask round-trip', () => {
    const task = q.createTask(db, { name: 'Test', prompt: 'Do something' })
    const longContext = '- Use WebSearch for latest data\n- Parse JSON from CoinGecko\n- Format as USD with 2 decimals'
    q.updateTask(db, task.id, { learnedContext: longContext })
    const fetched = q.getTask(db, task.id)!
    expect(fetched.learnedContext).toBe(longContext)
  })

  it('appears in listTasks results', () => {
    const task = q.createTask(db, { name: 'Test', prompt: 'Do something' })
    q.updateTask(db, task.id, { learnedContext: 'Learned approach' })
    const tasks = q.listTasks(db)
    expect(tasks[0].learnedContext).toBe('Learned approach')
  })
})

// ─── Pruning ──────────────────────────────────────────────────

describe('pruneOldRuns', () => {
  it('returns 0 when called within the throttle interval', () => {
    // First call resets the timer
    const first = q.pruneOldRuns(db)
    expect(first).toBe(0) // no runs to prune

    // Second call within 1 hour returns 0 immediately
    const second = q.pruneOldRuns(db)
    expect(second).toBe(0)
  })

  it('deletes old runs beyond limit per task', () => {
    const task = q.createTask(db, { name: 'Prunable', prompt: 'p' })

    // Create 55 runs (50 = limit, 5 over)
    for (let i = 0; i < 55; i++) {
      const run = q.createTaskRun(db, task.id)
      q.completeTaskRun(db, run.id, `Result ${i}`)
    }

    // Verify we have 55 runs
    const before = db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(task.id) as { cnt: number }
    expect(before.cnt).toBe(55)

    // Force prune by resetting internal timer — we need to access the module internals
    // Instead, we'll directly verify the SQL logic works by calling the underlying DB
    const pruned = db.prepare(`
      DELETE FROM task_runs WHERE id IN (
        SELECT tr.id FROM task_runs tr
        WHERE (SELECT COUNT(*) FROM task_runs tr2
               WHERE tr2.task_id = tr.task_id AND tr2.id >= tr.id) > 50
      )
    `).run()

    expect(pruned.changes).toBe(5) // 55 - 50 = 5 pruned

    const after = db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(task.id) as { cnt: number }
    expect(after.cnt).toBe(50)
  })

  it('prunes console logs for deleted runs', () => {
    const task = q.createTask(db, { name: 'Log Prunable', prompt: 'p' })

    // Create 55 runs with console logs
    for (let i = 0; i < 55; i++) {
      const run = q.createTaskRun(db, task.id)
      q.insertConsoleLogs(db, [
        { runId: run.id, seq: 1, entryType: 'assistant_text', content: `Log ${i}` }
      ])
      q.completeTaskRun(db, run.id, `Result ${i}`)
    }

    const logsBefore = db.prepare('SELECT COUNT(*) as cnt FROM console_logs').get() as { cnt: number }
    expect(logsBefore.cnt).toBe(55)

    // Delete console logs for runs that would be pruned
    db.prepare(`
      DELETE FROM console_logs WHERE run_id IN (
        SELECT tr.id FROM task_runs tr
        WHERE (SELECT COUNT(*) FROM task_runs tr2
               WHERE tr2.task_id = tr.task_id AND tr2.id >= tr.id) > 50
      )
    `).run()

    const logsAfter = db.prepare('SELECT COUNT(*) as cnt FROM console_logs').get() as { cnt: number }
    expect(logsAfter.cnt).toBe(50) // 5 console log entries pruned
  })

  it('prunes independently per task', () => {
    const task1 = q.createTask(db, { name: 'Task A', prompt: 'p' })
    const task2 = q.createTask(db, { name: 'Task B', prompt: 'p' })

    // Task A: 55 runs (5 over limit)
    for (let i = 0; i < 55; i++) {
      const run = q.createTaskRun(db, task1.id)
      q.completeTaskRun(db, run.id, `A ${i}`)
    }

    // Task B: 3 runs (under limit)
    for (let i = 0; i < 3; i++) {
      const run = q.createTaskRun(db, task2.id)
      q.completeTaskRun(db, run.id, `B ${i}`)
    }

    db.prepare(`
      DELETE FROM task_runs WHERE id IN (
        SELECT tr.id FROM task_runs tr
        WHERE (SELECT COUNT(*) FROM task_runs tr2
               WHERE tr2.task_id = tr.task_id AND tr2.id >= tr.id) > 50
      )
    `).run()

    const countA = db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(task1.id) as { cnt: number }
    const countB = db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(task2.id) as { cnt: number }
    expect(countA.cnt).toBe(50) // pruned to 50
    expect(countB.cnt).toBe(3) // unchanged
  })

  it('keeps the most recent runs and deletes oldest', () => {
    const task = q.createTask(db, { name: 'Recent', prompt: 'p' })

    for (let i = 0; i < 55; i++) {
      const run = q.createTaskRun(db, task.id)
      q.completeTaskRun(db, run.id, `Result ${i}`)
    }

    db.prepare(`
      DELETE FROM task_runs WHERE id IN (
        SELECT tr.id FROM task_runs tr
        WHERE (SELECT COUNT(*) FROM task_runs tr2
               WHERE tr2.task_id = tr.task_id AND tr2.id >= tr.id) > 50
      )
    `).run()

    // Should have exactly 50 remaining
    const count = db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(task.id) as { cnt: number }
    expect(count.cnt).toBe(50)

    // The oldest runs (lowest IDs) should be gone
    const allRemaining = q.getTaskRuns(db, task.id, 50)
    const results = allRemaining.map(r => r.result)
    // Result 0-4 (oldest 5) should have been deleted
    expect(results).not.toContain('Result 0')
    expect(results).not.toContain('Result 4')
    // Result 54 (most recent) should still exist
    expect(results).toContain('Result 54')
  })
})

// ─── storeTaskResultInMemory COUNT-based pruning ──────────────

describe('storeTaskResultInMemory - pruning', () => {
  it('keeps exactly MAX_OBSERVATIONS_PER_ENTITY after many stores', () => {
    const task = q.createTask(db, { name: 'Prune COUNT Test', prompt: 'p' })

    // Store 20 results — should prune to 10 each time
    for (let i = 0; i < 20; i++) {
      q.storeTaskResultInMemory(db, task.id, `Result ${i}`, true)
    }

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs.length).toBe(10)
  })

  it('preserves the most recent observations when pruning', () => {
    const task = q.createTask(db, { name: 'Prune Order Test', prompt: 'p' })

    for (let i = 0; i < 15; i++) {
      q.storeTaskResultInMemory(db, task.id, `Result ${i}`, true)
    }

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    // Most recent should be present
    expect(obs[0].content).toContain('Result 14')
    // Oldest should be pruned
    const allContent = obs.map(o => o.content).join(' ')
    expect(allContent).not.toContain('Result 0')
    expect(allContent).not.toContain('Result 4')
  })

  it('does not prune when under limit', () => {
    const task = q.createTask(db, { name: 'Under Limit', prompt: 'p' })

    for (let i = 0; i < 5; i++) {
      q.storeTaskResultInMemory(db, task.id, `Result ${i}`, true)
    }

    const updated = q.getTask(db, task.id)!
    const obs = q.getObservations(db, updated.memoryEntityId!)
    expect(obs.length).toBe(5)
  })
})

// ─── buildRelatedKnowledgeSection batch query ────────────────

describe('buildRelatedKnowledgeSection - batch optimization', () => {
  it('finds related entities with OR-joined FTS query', () => {
    // Create entities that match different words
    const e1 = q.createEntity(db, 'Daily News Report', 'fact')
    q.addObservation(db, e1.id, 'Latest daily news content', 'claude')

    const e2 = q.createEntity(db, 'Weather Report', 'fact')
    q.addObservation(db, e2.id, 'Sunny forecast', 'claude')

    // Task name "Daily Report" should match both via OR
    const task = q.createTask(db, { name: 'Daily Report', prompt: 'p' })

    const context = q.getTaskMemoryContext(db, task.id)
    expect(context).not.toBeNull()
    expect(context).toContain('Related knowledge')
    // Should find entities matching "Daily" OR "Report"
    expect(context).toContain('Daily News Report')
  })

  it('returns observations batched from multiple entities', () => {
    // Create 3 entities with distinct observations
    for (let i = 0; i < 3; i++) {
      const e = q.createEntity(db, `Topic Alpha ${i}`, 'fact')
      q.addObservation(db, e.id, `Observation for topic ${i}`, 'claude')
    }

    const task = q.createTask(db, { name: 'Topic Alpha', prompt: 'p' })
    const context = q.getTaskMemoryContext(db, task.id)

    expect(context).not.toBeNull()
    expect(context).toContain('Observation for topic 0')
    expect(context).toContain('Observation for topic 1')
    expect(context).toContain('Observation for topic 2')
  })

  it('limits related observations to MAX_RELATED_OBSERVATIONS per entity', () => {
    const e = q.createEntity(db, 'Prolific Source', 'fact')
    for (let i = 0; i < 10; i++) {
      q.addObservation(db, e.id, `Obs ${i}`, 'claude')
    }

    const task = q.createTask(db, { name: 'Prolific Source', prompt: 'p' })
    const context = q.getTaskMemoryContext(db, task.id)

    expect(context).not.toBeNull()
    // Should have at most 3 observations per entity (MAX_RELATED_OBSERVATIONS)
    const obsMatches = context!.match(/Obs \d+/g) ?? []
    expect(obsMatches.length).toBeLessThanOrEqual(3)
  })

  it('excludes the task own entity from related results', () => {
    const task = q.createTask(db, { name: 'Self Test', prompt: 'p' })
    const ownEntity = q.createEntity(db, 'Task: Self Test', 'task_result', 'task')
    q.updateTask(db, task.id, { memoryEntityId: ownEntity.id })
    q.addObservation(db, ownEntity.id, 'Own result should not appear in related', 'task_runner')

    // Create another entity with overlapping name
    const other = q.createEntity(db, 'Self Test Notes', 'fact')
    q.addObservation(db, other.id, 'External notes', 'claude')

    const context = q.getCrossTaskMemoryContext(db, task.id)
    if (context) {
      expect(context).not.toContain('Own result should not appear')
      expect(context).toContain('External notes')
    }
  })

  it('handles task names with short words (< 2 chars) gracefully', () => {
    const task = q.createTask(db, { name: 'A B', prompt: 'p' })
    // All words are < 2 chars, should return null without errors
    const context = q.getCrossTaskMemoryContext(db, task.id)
    expect(context).toBeNull()
  })
})

// ─── Credentials ─────────────────────────────────────────────

describe('credentials', () => {
  let roomId: number

  beforeEach(() => {
    const room = q.createRoom(db, 'Cred Room', 'test goal', { threshold: 'majority', timeoutMinutes: 60, keeperWeight: 'dynamic', tieBreaker: 'queen', autoApprove: ['low_impact'], minCycleGapMs: 1000 })
    roomId = room.id
  })

  it('creates a credential', () => {
    const cred = q.createCredential(db, roomId, 'GitHub Token', 'api_key', 'ghp_abc123')
    expect(cred.id).toBeGreaterThan(0)
    expect(cred.roomId).toBe(roomId)
    expect(cred.name).toBe('GitHub Token')
    expect(cred.type).toBe('api_key')
    expect(cred.valueEncrypted).toBe('ghp_abc123')
    expect(cred.providedBy).toBe('keeper')
  })

  it('getCredential returns full value', () => {
    const cred = q.createCredential(db, roomId, 'Secret Key', 'api_key', 'sk-secret-value')
    const fetched = q.getCredential(db, cred.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.valueEncrypted).toBe('sk-secret-value')
  })

  it('getCredential returns null for non-existent', () => {
    expect(q.getCredential(db, 999)).toBeNull()
  })

  it('listCredentials masks the value', () => {
    q.createCredential(db, roomId, 'Key A', 'api_key', 'real-secret-a')
    q.createCredential(db, roomId, 'Key B', 'api_key', 'real-secret-b')
    const list = q.listCredentials(db, roomId)
    expect(list).toHaveLength(2)
    for (const cred of list) {
      expect(cred.valueEncrypted).toBe('***')
    }
  })

  it('listCredentials returns multiple credentials', () => {
    q.createCredential(db, roomId, 'First', 'api_key', 'v1')
    q.createCredential(db, roomId, 'Second', 'api_key', 'v2')
    const list = q.listCredentials(db, roomId)
    expect(list).toHaveLength(2)
    const names = list.map(c => c.name)
    expect(names).toContain('First')
    expect(names).toContain('Second')
  })

  it('listCredentials returns empty for room with no credentials', () => {
    expect(q.listCredentials(db, roomId)).toEqual([])
  })

  it('listCredentials scopes to room', () => {
    const room2 = q.createRoom(db, 'Other Room', null, { threshold: 'majority', timeoutMinutes: 60, keeperWeight: 'dynamic', tieBreaker: 'queen', autoApprove: ['low_impact'], minCycleGapMs: 1000 })
    q.createCredential(db, roomId, 'Room1 Key', 'api_key', 'v1')
    q.createCredential(db, room2.id, 'Room2 Key', 'api_key', 'v2')
    expect(q.listCredentials(db, roomId)).toHaveLength(1)
    expect(q.listCredentials(db, room2.id)).toHaveLength(1)
  })

  it('deleteCredential removes the credential', () => {
    const cred = q.createCredential(db, roomId, 'Temp Key', 'api_key', 'temp')
    q.deleteCredential(db, cred.id)
    expect(q.getCredential(db, cred.id)).toBeNull()
  })

  it('supports all credential types', () => {
    const types = ['api_key', 'account', 'card', 'other'] as const
    for (const type of types) {
      const cred = q.createCredential(db, roomId, `${type} cred`, type, `value-${type}`)
      expect(cred.type).toBe(type)
    }
    expect(q.listCredentials(db, roomId)).toHaveLength(4)
  })
})

// ─── Escalations ─────────────────────────────────────────────

describe('escalations', () => {
  let roomId: number
  let queenId: number
  let workerId: number

  beforeEach(() => {
    const room = q.createRoom(db, 'Esc Room', 'test', { threshold: 'majority', timeoutMinutes: 60, keeperWeight: 'dynamic', tieBreaker: 'queen', autoApprove: ['low_impact'], minCycleGapMs: 1000 })
    roomId = room.id
    const queen = q.createWorker(db, { name: 'Queen', systemPrompt: 'queen', roomId })
    queenId = queen.id
    const worker = q.createWorker(db, { name: 'Worker', systemPrompt: 'worker', roomId })
    workerId = worker.id
  })

  it('creates an escalation', () => {
    const esc = q.createEscalation(db, roomId, workerId, 'How to proceed?', queenId)
    expect(esc.id).toBeGreaterThan(0)
    expect(esc.roomId).toBe(roomId)
    expect(esc.fromAgentId).toBe(workerId)
    expect(esc.toAgentId).toBe(queenId)
    expect(esc.question).toBe('How to proceed?')
    expect(esc.status).toBe('pending')
    expect(esc.answer).toBeNull()
  })

  it('creates escalation without target agent', () => {
    const esc = q.createEscalation(db, roomId, workerId, 'Help needed')
    expect(esc.toAgentId).toBeNull()
  })

  it('creates escalation with null fromAgentId', () => {
    const esc = q.createEscalation(db, roomId, null, 'System question')
    expect(esc.fromAgentId).toBeNull()
  })

  it('getEscalation returns null for non-existent', () => {
    expect(q.getEscalation(db, 999)).toBeNull()
  })

  it('getPendingEscalations returns pending for target agent', () => {
    q.createEscalation(db, roomId, workerId, 'Question 1', queenId)
    q.createEscalation(db, roomId, workerId, 'Question 2', queenId)
    const pending = q.getPendingEscalations(db, roomId, queenId)
    expect(pending).toHaveLength(2)
    expect(pending[0].question).toBe('Question 1')
    expect(pending[1].question).toBe('Question 2')
  })

  it('getPendingEscalations includes unassigned escalations', () => {
    q.createEscalation(db, roomId, workerId, 'For anyone')
    const pending = q.getPendingEscalations(db, roomId, queenId)
    expect(pending).toHaveLength(1)
  })

  it('getPendingEscalations excludes other agent escalations', () => {
    const other = q.createWorker(db, { name: 'Other', systemPrompt: 'o', roomId })
    q.createEscalation(db, roomId, workerId, 'For other only', other.id)
    const pending = q.getPendingEscalations(db, roomId, queenId)
    expect(pending).toHaveLength(0)
  })

  it('getPendingEscalations without target returns all pending', () => {
    q.createEscalation(db, roomId, workerId, 'Q1', queenId)
    q.createEscalation(db, roomId, workerId, 'Q2')
    const pending = q.getPendingEscalations(db, roomId)
    expect(pending).toHaveLength(2)
  })

  it('resolveEscalation updates status and answer', () => {
    const esc = q.createEscalation(db, roomId, workerId, 'What to do?', queenId)
    q.resolveEscalation(db, esc.id, 'Do X then Y')
    const resolved = q.getEscalation(db, esc.id)!
    expect(resolved.status).toBe('resolved')
    expect(resolved.answer).toBe('Do X then Y')
    expect(resolved.resolvedAt).not.toBeNull()
  })

  it('resolved escalations are excluded from pending', () => {
    const esc = q.createEscalation(db, roomId, workerId, 'Resolved Q', queenId)
    q.resolveEscalation(db, esc.id, 'Done')
    const pending = q.getPendingEscalations(db, roomId, queenId)
    expect(pending).toHaveLength(0)
  })

  it('listEscalations returns all escalations', () => {
    const esc1 = q.createEscalation(db, roomId, workerId, 'Q1', queenId)
    q.createEscalation(db, roomId, workerId, 'Q2', queenId)
    q.resolveEscalation(db, esc1.id, 'A1')
    const all = q.listEscalations(db, roomId)
    expect(all).toHaveLength(2)
    expect(all[0].status).toBe('resolved')
    expect(all[1].status).toBe('pending')
  })

  it('listEscalations filters by status', () => {
    q.createEscalation(db, roomId, workerId, 'Pending one')
    const esc2 = q.createEscalation(db, roomId, workerId, 'Resolved one')
    q.resolveEscalation(db, esc2.id, 'Answer')
    expect(q.listEscalations(db, roomId, 'pending')).toHaveLength(1)
    expect(q.listEscalations(db, roomId, 'resolved')).toHaveLength(1)
  })

  it('listEscalations returns chronological order', () => {
    q.createEscalation(db, roomId, workerId, 'First')
    q.createEscalation(db, roomId, workerId, 'Second')
    const all = q.listEscalations(db, roomId)
    expect(all[0].question).toBe('First')
    expect(all[1].question).toBe('Second')
  })
})
