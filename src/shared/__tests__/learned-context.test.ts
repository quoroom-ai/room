import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Task } from '../types'
import { shouldDistill, distillLearnedContext } from '../learned-context'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'

vi.mock('../claude-code', () => ({
  executeClaudeCode: vi.fn()
}))

import { executeClaudeCode } from '../claude-code'
const mockExecute = vi.mocked(executeClaudeCode)

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: 'BTC Price Check',
    description: null,
    prompt: 'Get Bitcoin price',
    cronExpression: '0 9 * * *',
    triggerType: 'cron',
    triggerConfig: null,
    scheduledAt: null,
    executor: 'claude_code',
    status: 'active',
    lastRun: null,
    lastResult: null,
    errorCount: 0,
    maxRuns: null,
    runCount: 0,
    memoryEntityId: null,
    workerId: null,
    sessionContinuity: false,
    sessionId: null,
    timeoutMinutes: null,
    maxTurns: null,
    allowedTools: null,
    disallowedTools: null,
    learnedContext: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

describe('shouldDistill', () => {
  it('returns false for one-shot tasks (triggerType: once)', () => {
    const task = makeTask({ triggerType: 'once', runCount: 5 })
    expect(shouldDistill(task)).toBe(false)
  })

  it('returns false for tasks with maxRuns: 1', () => {
    const task = makeTask({ maxRuns: 1, runCount: 5 })
    expect(shouldDistill(task)).toBe(false)
  })

  it('returns false when runCount < 3', () => {
    const task = makeTask({ runCount: 2 })
    expect(shouldDistill(task)).toBe(false)
  })

  it('returns true at runCount 3 when no learnedContext', () => {
    const task = makeTask({ runCount: 3, learnedContext: null })
    expect(shouldDistill(task)).toBe(true)
  })

  it('returns true at runCount 5 when no learnedContext', () => {
    const task = makeTask({ runCount: 5, learnedContext: null })
    expect(shouldDistill(task)).toBe(true)
  })

  it('returns true at runCount 6 even with existing learnedContext (periodic refresh)', () => {
    const task = makeTask({ runCount: 6, learnedContext: 'Use CoinGecko API' })
    expect(shouldDistill(task)).toBe(true)
  })

  it('returns false at runCount 4 with existing learnedContext', () => {
    const task = makeTask({ runCount: 4, learnedContext: 'Use CoinGecko API' })
    expect(shouldDistill(task)).toBe(false)
  })

  it('returns true at runCount 9 with existing learnedContext (periodic refresh)', () => {
    const task = makeTask({ runCount: 9, learnedContext: 'Use CoinGecko API' })
    expect(shouldDistill(task)).toBe(true)
  })

  it('returns false for manual tasks with maxRuns: 1', () => {
    const task = makeTask({ triggerType: 'manual', maxRuns: 1, runCount: 5 })
    expect(shouldDistill(task)).toBe(false)
  })

  it('returns true for manual tasks with no maxRuns', () => {
    const task = makeTask({ triggerType: 'manual', maxRuns: null, runCount: 3 })
    expect(shouldDistill(task)).toBe(true)
  })

  it('returns true for cron tasks with high maxRuns', () => {
    const task = makeTask({ triggerType: 'cron', maxRuns: 100, runCount: 3 })
    expect(shouldDistill(task)).toBe(true)
  })
})

// ─── distillLearnedContext ──────────────────────────────────────

describe('distillLearnedContext', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initTestDb()
    mockExecute.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  it('returns null for non-existent task', async () => {
    const result = await distillLearnedContext(db, 999)
    expect(result).toBeNull()
  })

  it('returns null when fewer than 2 successful runs', async () => {
    const task = queries.createTask(db, { name: 'New Task', prompt: 'Do stuff', triggerType: 'manual' })
    // Create 1 successful run
    const run = queries.createTaskRun(db, task.id)
    queries.completeTaskRun(db, run.id, 'Result 1')

    const result = await distillLearnedContext(db, task.id)
    expect(result).toBeNull()
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('calls Claude and stores learned context on success', async () => {
    const task = queries.createTask(db, { name: 'BTC Price', prompt: 'Get price', triggerType: 'manual' })

    // Create 3 successful runs
    for (let i = 0; i < 3; i++) {
      const run = queries.createTaskRun(db, task.id)
      queries.completeTaskRun(db, run.id, `BTC was $${50000 + i * 100}`)
    }

    mockExecute.mockResolvedValue({
      stdout: '- Use CoinGecko /simple/price endpoint\n- Parse JSON for USD field',
      stderr: '', exitCode: 0, durationMs: 5000, timedOut: false, sessionId: null
    })

    const result = await distillLearnedContext(db, task.id)

    expect(result).toBe('- Use CoinGecko /simple/price endpoint\n- Parse JSON for USD field')
    expect(mockExecute).toHaveBeenCalledTimes(1)

    // Verify it's stored in DB
    const updated = queries.getTask(db, task.id)!
    expect(updated.learnedContext).toBe('- Use CoinGecko /simple/price endpoint\n- Parse JSON for USD field')
  })

  it('returns null when Claude call fails', async () => {
    const task = queries.createTask(db, { name: 'Fail Task', prompt: 'Do stuff', triggerType: 'manual' })

    for (let i = 0; i < 3; i++) {
      const run = queries.createTaskRun(db, task.id)
      queries.completeTaskRun(db, run.id, `Result ${i}`)
    }

    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'error', exitCode: 1, durationMs: 100, timedOut: false, sessionId: null
    })

    const result = await distillLearnedContext(db, task.id)
    expect(result).toBeNull()

    // Verify nothing was stored
    const updated = queries.getTask(db, task.id)!
    expect(updated.learnedContext).toBeNull()
  })

  it('includes task name and prompt in distillation prompt', async () => {
    const task = queries.createTask(db, { name: 'HN Digest', prompt: 'Summarize top HN stories', triggerType: 'manual' })

    for (let i = 0; i < 3; i++) {
      const run = queries.createTaskRun(db, task.id)
      queries.completeTaskRun(db, run.id, `Story ${i}`)
    }

    mockExecute.mockResolvedValue({
      stdout: '- Use HN API', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await distillLearnedContext(db, task.id)

    const calledPrompt = mockExecute.mock.calls[0][0]
    expect(calledPrompt).toContain('HN Digest')
    expect(calledPrompt).toContain('Summarize top HN stories')
    expect(calledPrompt).toContain('methodology memo')
  })

  it('passes maxTurns: 1 to prevent tool use', async () => {
    const task = queries.createTask(db, { name: 'Test', prompt: 'Work', triggerType: 'manual' })

    for (let i = 0; i < 3; i++) {
      const run = queries.createTaskRun(db, task.id)
      queries.completeTaskRun(db, run.id, `Result ${i}`)
    }

    mockExecute.mockResolvedValue({
      stdout: '- Approach', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await distillLearnedContext(db, task.id)

    const options = mockExecute.mock.calls[0][1]
    expect(options?.maxTurns).toBe(1)
  })

  it('truncates learned context to 1500 chars', async () => {
    const task = queries.createTask(db, { name: 'Verbose', prompt: 'Work', triggerType: 'manual' })

    for (let i = 0; i < 3; i++) {
      const run = queries.createTaskRun(db, task.id)
      queries.completeTaskRun(db, run.id, `Result ${i}`)
    }

    const longOutput = 'x'.repeat(2000)
    mockExecute.mockResolvedValue({
      stdout: longOutput, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    const result = await distillLearnedContext(db, task.id)
    expect(result!.length).toBe(1500)
  })
})
