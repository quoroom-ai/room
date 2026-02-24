import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as queries from '../db-queries'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { initTestDb } from './helpers/test-db'

// Mock executeClaudeCode and sleep before importing task-runner
vi.mock('../claude-code', () => ({
  executeClaudeCode: vi.fn()
}))

vi.mock('../rate-limit', async () => {
  const actual = await vi.importActual('../rate-limit') as Record<string, unknown>
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined) // instant sleep in tests
  }
})

import { executeTask, isTaskRunning } from '../task-runner'
import { executeClaudeCode } from '../claude-code'
import { sleep } from '../rate-limit'

const mockExecute = vi.mocked(executeClaudeCode)
const mockSleep = vi.mocked(sleep)

let db: Database.Database
let resultsDir: string

function createActiveTask(name = 'Test Task', prompt = 'Do something'): number {
  const task = queries.createTask(db, {
    name,
    prompt,
    triggerType: 'manual',
    executor: 'claude_code'
  })
  return task.id
}

beforeEach(() => {
  db = initTestDb()
  resultsDir = mkdtempSync(join(tmpdir(), 'quoroom-test-'))
  mockExecute.mockReset()
  mockSleep.mockClear()
})

afterEach(() => {
  db.close()
  if (existsSync(resultsDir)) {
    rmSync(resultsDir, { recursive: true })
  }
})

// ─── Task Not Found ─────────────────────────────────────────────

describe('executeTask - task not found', () => {
  it('returns error for non-existent task', async () => {
    const result = await executeTask(999, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toMatch(/not found/)
  })
})

// ─── Task Status Checks ────────────────────────────────────────

describe('executeTask - status checks', () => {
  it('returns error for paused task', async () => {
    const id = createActiveTask()
    queries.pauseTask(db, id)

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toMatch(/paused/)
  })

  it('returns error for completed task', async () => {
    const id = createActiveTask()
    queries.updateTask(db, id, { status: 'completed' })

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toMatch(/completed/)
  })
})

// ─── Cross-Process Safety ──────────────────────────────────────

describe('executeTask - cross-process concurrency', () => {
  it('rejects when another process has a running TaskRun', async () => {
    const id = createActiveTask()
    // Simulate another process having started this task
    queries.createTaskRun(db, id) // status='running' by default

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toMatch(/running execution/)
  })
})

describe('executeTask - keeper reminder executor', () => {
  it('delivers reminder to clerk messages without model execution', async () => {
    const task = queries.createTask(db, {
      name: 'Reminder Task',
      prompt: 'Check stalled rooms and follow up.',
      triggerType: 'manual',
      executor: 'keeper_reminder'
    })

    const onComplete = vi.fn()
    const result = await executeTask(task.id, { db, resultsDir, onComplete })

    expect(result.success).toBe(true)
    expect(result.output).toContain('Reminder:')
    expect(result.output).toContain('Check stalled rooms')
    expect(mockExecute).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()

    const runs = queries.getTaskRuns(db, task.id, 10)
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('completed')

    const messages = queries.listClerkMessages(db, 10)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('commentary')
    expect(messages[0].source).toBe('task')
    expect(messages[0].content).toContain('Check stalled rooms')

    expect(queries.getTask(db, task.id)!.runCount).toBe(1)
  })
})

describe('executeTask - keeper contact check executor', () => {
  it('asks keeper to connect contacts when email/telegram are missing', async () => {
    const task = queries.createTask(db, {
      name: 'Contact Check',
      prompt: 'check contacts',
      triggerType: 'manual',
      executor: 'keeper_contact_check'
    })

    const result = await executeTask(task.id, { db, resultsDir })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Keeper action needed:')
    expect(result.output.toLowerCase()).toContain('email')
    expect(result.output.toLowerCase()).toContain('telegram')
    expect(mockExecute).not.toHaveBeenCalled()

    const messages = queries.listClerkMessages(db, 10)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe('commentary')
    expect(messages[0].source).toBe('task')
    expect(messages[0].content).toContain('Keeper action needed:')
  })

  it('does not send reminder when keeper already has verified email and telegram', async () => {
    queries.setSetting(db, 'contact_email', 'keeper@example.com')
    queries.setSetting(db, 'contact_email_verified_at', new Date().toISOString())
    queries.setSetting(db, 'contact_telegram_id', '123456789')
    queries.setSetting(db, 'contact_telegram_verified_at', new Date().toISOString())

    const task = queries.createTask(db, {
      name: 'Contact Check Connected',
      prompt: 'check contacts',
      triggerType: 'manual',
      executor: 'keeper_contact_check'
    })

    const result = await executeTask(task.id, { db, resultsDir })
    expect(result.success).toBe(true)
    expect(result.output).toContain('no reminder sent')
    expect(mockExecute).not.toHaveBeenCalled()

    const messages = queries.listClerkMessages(db, 10)
    expect(messages.length).toBe(0)
  })
})

// ─── Successful Execution ──────────────────────────────────────

describe('executeTask - success', () => {
  it('executes task and returns output', async () => {
    const id = createActiveTask('My Task', 'Say hello')
    mockExecute.mockResolvedValue({
      stdout: 'Hello world',
      stderr: '',
      exitCode: 0,
      durationMs: 1234,
      timedOut: false,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Hello world')
    expect(result.durationMs).toBe(1234)
    expect(mockExecute).toHaveBeenCalledWith('Say hello', expect.objectContaining({
      onProgress: expect.any(Function)
    }))
  })

  it('creates a TaskRun record', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: 'Done',
      stderr: '',
      exitCode: 0,
      durationMs: 500,
      timedOut: false,
      sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const runs = queries.getTaskRuns(db, id, 10)
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('completed')
    expect(runs[0].result).toBe('Done')
  })

  it('saves result to markdown file', async () => {
    const id = createActiveTask('File Task')
    mockExecute.mockResolvedValue({
      stdout: 'File output',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    expect(result.resultFilePath).toBeDefined()
    expect(existsSync(result.resultFilePath!)).toBe(true)

    const content = readFileSync(result.resultFilePath!, 'utf-8')
    expect(content).toContain('# Task: File Task')
    expect(content).toContain('File output')
    expect(content).toContain('Success')
  })

  it('calls onComplete callback', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: 'Result text here',
      stderr: '',
      exitCode: 0,
      durationMs: 200,
      timedOut: false,
      sessionId: null
    })

    const onComplete = vi.fn()
    await executeTask(id, { db, resultsDir, onComplete })
    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete.mock.calls[0][0].name).toBe('Test Task')
    expect(onComplete.mock.calls[0][1]).toBe('Result text here')
  })
})

// ─── Failed Execution ──────────────────────────────────────────

describe('executeTask - failure', () => {
  it('handles non-zero exit code', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'Something broke',
      exitCode: 1,
      durationMs: 300,
      timedOut: false,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('Exit code 1')
    expect(result.errorMessage).toContain('Something broke')
  })

  it('handles timeout', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: 'Partial output',
      stderr: '',
      exitCode: 1,
      durationMs: 300000,
      timedOut: true,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('Timed out')
  })

  it('records error in TaskRun', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'crash',
      exitCode: 2,
      durationMs: 50,
      timedOut: false,
      sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const runs = queries.getTaskRuns(db, id, 10)
    expect(runs[0].status).toBe('failed')
    expect(runs[0].errorMessage).toContain('Exit code 2')
  })

  it('calls onFailed callback', async () => {
    const id = createActiveTask()
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    const onFailed = vi.fn()
    await executeTask(id, { db, resultsDir, onFailed })
    expect(onFailed).toHaveBeenCalledOnce()
    expect(onFailed.mock.calls[0][1]).toContain('Exit code 1')
  })

  it('handles executor exception', async () => {
    const id = createActiveTask()
    mockExecute.mockRejectedValue(new Error('spawn failed'))

    const result = await executeTask(id, { db, resultsDir })
    expect(result.success).toBe(false)
    expect(result.errorMessage).toBe('spawn failed')

    const runs = queries.getTaskRuns(db, id, 10)
    expect(runs[0].status).toBe('failed')
    expect(runs[0].errorMessage).toBe('spawn failed')
  })
})

// ─── maxRuns Auto-Complete ─────────────────────────────────────

describe('executeTask - maxRuns', () => {
  it('increments runCount on successful execution', async () => {
    const task = queries.createTask(db, {
      name: 'Counted',
      prompt: 'count me',
      triggerType: 'manual',
      maxRuns: 5
    })
    mockExecute.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(1)
    expect(queries.getTask(db, task.id)!.status).toBe('active')
  })

  it('auto-completes task when maxRuns is reached', async () => {
    const task = queries.createTask(db, {
      name: 'Limited',
      prompt: 'run me',
      triggerType: 'cron',
      cronExpression: '0 9 * * *',
      maxRuns: 2
    })
    mockExecute.mockResolvedValue({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    // First run
    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(1)
    expect(queries.getTask(db, task.id)!.status).toBe('active')

    // Second run — should trigger auto-complete
    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(2)
    expect(queries.getTask(db, task.id)!.status).toBe('completed')
  })

  it('does not increment runCount on failed execution', async () => {
    const task = queries.createTask(db, {
      name: 'Fail Counter',
      prompt: 'fail me',
      triggerType: 'manual',
      maxRuns: 3
    })
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'error',
      exitCode: 1,
      durationMs: 50,
      timedOut: false,
      sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(0)
    expect(queries.getTask(db, task.id)!.status).toBe('active')
  })

  it('does not auto-complete when maxRuns is null (unlimited)', async () => {
    const task = queries.createTask(db, {
      name: 'Unlimited',
      prompt: 'run forever',
      triggerType: 'manual'
    })
    mockExecute.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })
    await executeTask(task.id, { db, resultsDir })
    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(3)
    expect(queries.getTask(db, task.id)!.status).toBe('active')
  })

  it('auto-completes with maxRuns=1 after a single run', async () => {
    const task = queries.createTask(db, {
      name: 'One Shot',
      prompt: 'once',
      triggerType: 'manual',
      maxRuns: 1
    })
    mockExecute.mockResolvedValue({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: 50,
      timedOut: false,
      sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })
    expect(queries.getTask(db, task.id)!.runCount).toBe(1)
    expect(queries.getTask(db, task.id)!.status).toBe('completed')
  })
})

// ─── isTaskRunning ─────────────────────────────────────────────

describe('isTaskRunning', () => {
  it('returns false when no task is running', () => {
    expect(isTaskRunning(42)).toBe(false)
  })
})

// ─── Result File ───────────────────────────────────────────────

describe('result file', () => {
  it('creates results directory if it does not exist', async () => {
    const id = createActiveTask()
    const nestedDir = join(resultsDir, 'nested', 'deep')
    mockExecute.mockResolvedValue({
      stdout: 'output',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
      timedOut: false,
      sessionId: null
    })

    await executeTask(id, { db, resultsDir: nestedDir })
    expect(existsSync(nestedDir)).toBe(true)
  })

  it('saves timed-out status in result file', async () => {
    const id = createActiveTask('Timeout Task')
    mockExecute.mockResolvedValue({
      stdout: 'partial',
      stderr: '',
      exitCode: 1,
      durationMs: 300000,
      timedOut: true,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    const content = readFileSync(result.resultFilePath!, 'utf-8')
    expect(content).toContain('Timed Out')
  })

  it('saves failed status in result file', async () => {
    const id = createActiveTask('Fail Task')
    mockExecute.mockResolvedValue({
      stdout: '',
      stderr: 'error',
      exitCode: 2,
      durationMs: 50,
      timedOut: false,
      sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })
    const content = readFileSync(result.resultFilePath!, 'utf-8')
    expect(content).toContain('Failed (exit 2)')
  })
})

// ─── Memory Integration ───────────────────────────────────────

describe('executeTask - memory integration', () => {
  it('injects memory context into prompt', async () => {
    const task = queries.createTask(db, {
      name: 'Memory Task',
      prompt: 'What is new today?',
      triggerType: 'manual',
      executor: 'claude_code'
    })
    // Pre-populate memory
    const entity = queries.createEntity(db, 'Task: Memory Task', 'task_result', 'task')
    queries.updateTask(db, task.id, { memoryEntityId: entity.id })
    queries.addObservation(db, entity.id, '[SUCCESS] Previous result data', 'task_runner')

    mockExecute.mockResolvedValue({
      stdout: 'New output', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    // Verify the prompt passed to Claude includes memory context
    const calledPrompt = mockExecute.mock.calls[0][0]
    expect(calledPrompt).toContain('Your previous results')
    expect(calledPrompt).toContain('Previous result data')
    expect(calledPrompt).toContain('What is new today?')
  })

  it('stores result in memory after successful execution', async () => {
    const id = createActiveTask('Store Result Task', 'Do work')
    mockExecute.mockResolvedValue({
      stdout: 'Task output for memory', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const task = queries.getTask(db, id)!
    expect(task.memoryEntityId).not.toBeNull()
    const obs = queries.getObservations(db, task.memoryEntityId!)
    expect(obs.length).toBe(1)
    expect(obs[0].content).toContain('[SUCCESS]')
    expect(obs[0].content).toContain('Task output for memory')
  })

  it('stores failure in memory after failed execution', async () => {
    const id = createActiveTask('Fail Memory Task', 'Try something')
    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'error output', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const task = queries.getTask(db, id)!
    expect(task.memoryEntityId).not.toBeNull()
    const obs = queries.getObservations(db, task.memoryEntityId!)
    expect(obs.length).toBe(1)
    expect(obs[0].content).toContain('[FAILED]')
  })

  it('executes without memory context on first run', async () => {
    const id = createActiveTask('Fresh Task', 'First time run')
    mockExecute.mockResolvedValue({
      stdout: 'First run output', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    // Prompt should be unmodified (no memory context)
    const calledPrompt = mockExecute.mock.calls[0][0]
    expect(calledPrompt).toBe('First time run')
  })

  it('accumulates memory across multiple runs', async () => {
    const id = createActiveTask('Multi Run', 'Check things')

    for (let i = 0; i < 3; i++) {
      mockExecute.mockResolvedValue({
        stdout: `Run ${i} output`, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
      await executeTask(id, { db, resultsDir })
    }

    const task = queries.getTask(db, id)!
    const obs = queries.getObservations(db, task.memoryEntityId!)
    expect(obs.length).toBe(3)

    // Third run should have had context from first two
    const thirdCallPrompt = mockExecute.mock.calls[2][0]
    expect(thirdCallPrompt).toContain('Your previous results')
    expect(thirdCallPrompt).toContain('Run 1 output')
  })
})

// ─── Worker System Prompt ────────────────────────────────────

describe('executeTask - worker system prompt', () => {
  it('passes worker system prompt to executor', async () => {
    const worker = queries.createWorker(db, { name: 'Bot', systemPrompt: 'You are a bot.' })
    const task = queries.createTask(db, {
      name: 'Worker Task',
      prompt: 'Do work',
      triggerType: 'manual',
      workerId: worker.id
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith('Do work', expect.objectContaining({
      systemPrompt: 'You are a bot.'
    }))
  })

  it('passes worker model to executor when configured', async () => {
    const worker = queries.createWorker(db, {
      name: 'Model Worker',
      systemPrompt: 'You are focused.',
      model: 'claude-opus-4-1'
    })
    const task = queries.createTask(db, {
      name: 'Model Task',
      prompt: 'Do model-specific work',
      triggerType: 'manual',
      workerId: worker.id
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith('Do model-specific work', expect.objectContaining({
      model: 'claude-opus-4-1'
    }))
  })

  it('uses default worker when task has no worker', async () => {
    queries.createWorker(db, { name: 'Default', systemPrompt: 'Default prompt.', isDefault: true })
    const id = createActiveTask('No Worker', 'Do stuff')

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith('Do stuff', expect.objectContaining({
      systemPrompt: 'Default prompt.'
    }))
  })

  it('passes no systemPrompt when no workers exist', async () => {
    const id = createActiveTask('Plain Task', 'No worker')

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith('No worker', expect.objectContaining({
      systemPrompt: undefined
    }))
  })

  it('prefers task worker over default worker', async () => {
    queries.createWorker(db, { name: 'Default', systemPrompt: 'Default.', isDefault: true })
    const specific = queries.createWorker(db, { name: 'Specific', systemPrompt: 'Specific.' })
    const task = queries.createTask(db, {
      name: 'Specific Worker',
      prompt: 'Do it',
      triggerType: 'manual',
      workerId: specific.id
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith('Do it', expect.objectContaining({
      systemPrompt: 'Specific.'
    }))
  })
})

// ─── Task Timeout ──────────────────────────────────────────

describe('executeTask - timeout', () => {
  it('passes task-specific timeout to executeClaudeCode', async () => {
    const task = queries.createTask(db, {
      name: 'Long Task', prompt: 'Do research', triggerType: 'manual', timeoutMinutes: 60
    })

    mockExecute.mockResolvedValue({
      stdout: 'done', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timeoutMs: 60 * 60 * 1000
    }))
  })

  it('uses default timeout when task has no timeout set', async () => {
    const id = createActiveTask('Quick Task', 'Do something')

    mockExecute.mockResolvedValue({
      stdout: 'done', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timeoutMs: undefined
    }))
  })
})

// ─── Session Continuity ─────────────────────────────────────

describe('executeTask - session continuity', () => {
  it('stores session ID on task after successful run', async () => {
    const task = queries.createTask(db, {
      name: 'Session Task',
      prompt: 'Continue',
      triggerType: 'manual',
      sessionContinuity: true
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      sessionId: 'sess-new-123'
    })

    await executeTask(task.id, { db, resultsDir })

    const updated = queries.getTask(db, task.id)!
    expect(updated.sessionId).toBe('sess-new-123')
  })

  it('resumes session on subsequent run', async () => {
    const task = queries.createTask(db, {
      name: 'Resume Task',
      prompt: 'Continue work',
      triggerType: 'manual',
      sessionContinuity: true
    })
    queries.updateTask(db, task.id, { sessionId: 'sess-existing' })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      sessionId: 'sess-existing'
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      resumeSessionId: 'sess-existing'
    }))
  })

  it('does not resume session for non-continuous tasks', async () => {
    const task = queries.createTask(db, {
      name: 'Stateless',
      prompt: 'No session',
      triggerType: 'manual',
      sessionContinuity: false
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      sessionId: 'sess-abc'
    })

    await executeTask(task.id, { db, resultsDir })

    expect(mockExecute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      resumeSessionId: undefined
    }))
    // Should not store session on non-continuous task
    expect(queries.getTask(db, task.id)!.sessionId).toBeNull()
  })

  it('retries without session on resume failure', async () => {
    const task = queries.createTask(db, {
      name: 'Retry Task',
      prompt: 'Do retry',
      triggerType: 'manual',
      sessionContinuity: true
    })
    queries.updateTask(db, task.id, { sessionId: 'sess-broken' })

    // First call fails (resume failure), second call succeeds (fresh)
    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: 'resume error', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'fresh ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: 'sess-new'
      })

    const result = await executeTask(task.id, { db, resultsDir })

    expect(result.success).toBe(true)
    expect(result.output).toBe('fresh ok')
    // Should have cleared old session and stored new one
    expect(queries.getTask(db, task.id)!.sessionId).toBe('sess-new')
    // Should have been called twice
    expect(mockExecute).toHaveBeenCalledTimes(2)
    // Second call should NOT have resumeSessionId
    const retryOptions = mockExecute.mock.calls[1][1] as Record<string, unknown>
    expect(retryOptions.resumeSessionId).toBeUndefined()
  })

  it('stores session ID on task run', async () => {
    const task = queries.createTask(db, {
      name: 'Run Session',
      prompt: 'Go',
      triggerType: 'manual',
      sessionContinuity: true
    })

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false,
      sessionId: 'sess-run-123'
    })

    await executeTask(task.id, { db, resultsDir })

    const runs = queries.getTaskRuns(db, task.id, 1)
    expect(runs[0].sessionId).toBe('sess-run-123')
  })
})

// ─── Learned Context Injection ─────────────────────────────────

describe('executeTask - learned context', () => {
  it('injects learned context into prompt', async () => {
    const task = queries.createTask(db, {
      name: 'BTC Price',
      prompt: 'Get current Bitcoin price',
      triggerType: 'manual'
    })
    queries.updateTask(db, task.id, { learnedContext: '- Use CoinGecko API\n- Endpoint: /simple/price' })

    mockExecute.mockResolvedValue({
      stdout: 'BTC is $50k', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    const calledPrompt = mockExecute.mock.calls[0][0]
    expect(calledPrompt).toContain('Approach (learned from previous runs)')
    expect(calledPrompt).toContain('Use CoinGecko API')
    expect(calledPrompt).toContain('Get current Bitcoin price')
  })

  it('does not inject learned context when null', async () => {
    const id = createActiveTask('No Context', 'Just do it')
    mockExecute.mockResolvedValue({
      stdout: 'done', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const calledPrompt = mockExecute.mock.calls[0][0]
    expect(calledPrompt).not.toContain('Approach (learned from previous runs)')
    expect(calledPrompt).toBe('Just do it')
  })

  it('injects both learned context and memory context', async () => {
    const task = queries.createTask(db, {
      name: 'Dual Context',
      prompt: 'Check things',
      triggerType: 'manual'
    })
    // Set learned context
    queries.updateTask(db, task.id, { learnedContext: '- Use API v2' })
    // Set memory context
    const entity = queries.createEntity(db, 'Task: Dual Context', 'task_result', 'task')
    queries.updateTask(db, task.id, { memoryEntityId: entity.id })
    queries.addObservation(db, entity.id, '[SUCCESS] Previous data', 'task_runner')

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    const calledPrompt = mockExecute.mock.calls[0][0]
    // Both should be present
    expect(calledPrompt).toContain('Approach (learned from previous runs)')
    expect(calledPrompt).toContain('Use API v2')
    expect(calledPrompt).toContain('Your previous results')
    expect(calledPrompt).toContain('Previous data')
    expect(calledPrompt).toContain('Check things')
  })

  it('triggers distillation after 3 successful runs of a recurring task', async () => {
    const task = queries.createTask(db, {
      name: 'Recurring',
      prompt: 'Do recurring work',
      triggerType: 'cron',
      cronExpression: '0 9 * * *'
    })

    // Run 3 times successfully
    for (let i = 0; i < 3; i++) {
      mockExecute.mockResolvedValue({
        stdout: `Run ${i + 1} result`, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
      await executeTask(task.id, { db, resultsDir })
    }

    // The 3rd run should have triggered a distillation call (4th call to mockExecute)
    // Calls: run1, run2, run3, distillation
    expect(mockExecute.mock.calls.length).toBe(4)
    const distillPrompt = mockExecute.mock.calls[3][0]
    expect(distillPrompt).toContain('methodology memo')
    expect(distillPrompt).toContain('Recurring')
  })

  it('does not trigger distillation for one-shot tasks', async () => {
    const task = queries.createTask(db, {
      name: 'One Shot',
      prompt: 'Do once',
      triggerType: 'once',
      scheduledAt: new Date(Date.now() + 3600000).toISOString()
    })

    // Run 3 times (simulating manual re-runs)
    for (let i = 0; i < 3; i++) {
      // Re-activate since 'once' tasks auto-complete
      queries.updateTask(db, task.id, { status: 'active' })
      mockExecute.mockResolvedValue({
        stdout: `Run ${i + 1}`, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
      await executeTask(task.id, { db, resultsDir })
    }

    // Should only have 3 calls (no distillation)
    expect(mockExecute.mock.calls.length).toBe(3)
  })

  it('does not trigger distillation before runCount reaches 3', async () => {
    const task = queries.createTask(db, {
      name: 'Early',
      prompt: 'Too early',
      triggerType: 'manual'
    })

    // Run only twice
    for (let i = 0; i < 2; i++) {
      mockExecute.mockResolvedValue({
        stdout: `Run ${i + 1}`, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
      await executeTask(task.id, { db, resultsDir })
    }

    // Should only have 2 calls (no distillation)
    expect(mockExecute.mock.calls.length).toBe(2)
  })

  it('stores distilled context when distillation succeeds', async () => {
    const task = queries.createTask(db, {
      name: 'Distill Me',
      prompt: 'Work',
      triggerType: 'manual'
    })

    // First 2 runs
    for (let i = 0; i < 2; i++) {
      mockExecute.mockResolvedValueOnce({
        stdout: `Run ${i + 1} result`, stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
      await executeTask(task.id, { db, resultsDir })
    }

    // 3rd run triggers distillation — mock both the run and distillation
    mockExecute.mockResolvedValueOnce({
      stdout: 'Run 3 result', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })
    mockExecute.mockResolvedValueOnce({
      stdout: '- Use WebSearch for data\n- Parse JSON response', stderr: '', exitCode: 0, durationMs: 50, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    // Wait for async distillation to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    const updated = queries.getTask(db, task.id)!
    expect(updated.learnedContext).toBe('- Use WebSearch for data\n- Parse JSON response')
  })
})

// ─── Rate Limit Retry ──────────────────────────────────────────

describe('executeTask - rate limit retry', () => {
  it('retries after rate limit error and succeeds', async () => {
    const id = createActiveTask('Rate Limited Task', 'Do work')

    // First call: rate limited, second call: success
    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: 'Error: 429 rate_limit_error', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'Success after retry', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })

    const result = await executeTask(id, { db, resultsDir })

    expect(result.success).toBe(true)
    expect(result.output).toBe('Success after retry')
    expect(mockExecute).toHaveBeenCalledTimes(2)
    expect(mockSleep).toHaveBeenCalledTimes(1)
  })

  it('updates progress message during rate limit wait', async () => {
    const id = createActiveTask('Progress Task', 'Do work')

    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: 'rate limit exceeded', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })

    await executeTask(id, { db, resultsDir })

    // Check that progress was updated with rate limit message
    const runs = queries.getTaskRuns(db, id, 1)
    // The progress message may have been overwritten by completion, but console logs should have the entry
    const consoleLogs = queries.getConsoleLogs(db, runs[0].id, 0, 50)
    const rateLimitLog = consoleLogs.find(l => l.content.includes('Rate limit reached'))
    expect(rateLimitLog).toBeDefined()
    expect(rateLimitLog!.entryType).toBe('error')
  })

  it('rate-limit log entries use sequential seq values, not Date.now()', async () => {
    const id = createActiveTask('Seq Check', 'Do work')

    // All calls return rate limit error so we get multiple retry log entries
    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'usage limit reached', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    await executeTask(id, { db, resultsDir })

    const runs = queries.getTaskRuns(db, id, 1)
    const consoleLogs = queries.getConsoleLogs(db, runs[0].id, 0, 100)
    const rateLimitLogs = consoleLogs.filter(l => l.content.includes('Rate limit reached'))

    expect(rateLimitLogs.length).toBeGreaterThan(0)
    for (const log of rateLimitLogs) {
      // seq should be a reasonable number (< 10 million), not a Date.now() timestamp (~1.7 trillion)
      expect(log.seq).toBeLessThan(10_000_000)
    }
  })

  it('stops retrying after max retries and fails', async () => {
    const id = createActiveTask('Max Retry Task', 'Do work')

    // All calls return rate limit error
    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'usage limit reached', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })

    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('Exit code 1')
    // 1 initial + 3 retries = 4 calls
    expect(mockExecute).toHaveBeenCalledTimes(4)
    expect(mockSleep).toHaveBeenCalledTimes(3)
  })

  it('does not retry for non-rate-limit errors', async () => {
    const id = createActiveTask('Normal Error', 'Do work')

    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'Something broke', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })

    expect(result.success).toBe(false)
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockSleep).not.toHaveBeenCalled()
  })

  it('does not retry when exitCode is 0', async () => {
    const id = createActiveTask('Success Task', 'Do work')

    mockExecute.mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
    })

    const result = await executeTask(id, { db, resultsDir })

    expect(result.success).toBe(true)
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockSleep).not.toHaveBeenCalled()
  })

  it('calls onFailed only after final retry attempt', async () => {
    const id = createActiveTask('Callback Task', 'Do work')

    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'rate limit exceeded', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    const onFailed = vi.fn()
    const onComplete = vi.fn()
    await executeTask(id, { db, resultsDir, onComplete, onFailed })

    expect(onFailed).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('calls onComplete if a retry succeeds', async () => {
    const id = createActiveTask('Success Callback', 'Do work')

    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: 'too many requests', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'Success!', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })

    const onComplete = vi.fn()
    const onFailed = vi.fn()
    await executeTask(id, { db, resultsDir, onComplete, onFailed })

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('retries rate limit on session-resume retry path', async () => {
    const task = queries.createTask(db, {
      name: 'Session Rate Limit',
      prompt: 'Continue work',
      triggerType: 'manual',
      sessionContinuity: true
    })
    queries.updateTask(db, task.id, { sessionId: 'sess-broken' })

    // First call: session resume fails (non-rate-limit)
    // Second call (session retry): rate limited
    // Third call (rate limit retry): success
    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: 'session error', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: '', stderr: 'rate limit exceeded', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'Finally worked', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: 'sess-new'
      })

    const result = await executeTask(task.id, { db, resultsDir })

    expect(result.success).toBe(true)
    expect(result.output).toBe('Finally worked')
    expect(mockExecute).toHaveBeenCalledTimes(3)
    expect(mockSleep).toHaveBeenCalledTimes(1)
  })

  it('increments runCount when retry succeeds', async () => {
    const task = queries.createTask(db, {
      name: 'Count After Retry',
      prompt: 'Count me',
      triggerType: 'manual',
      maxRuns: 5
    })

    mockExecute
      .mockResolvedValueOnce({
        stdout: '', stderr: '429 rate_limit_error', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
      })
      .mockResolvedValueOnce({
        stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })

    await executeTask(task.id, { db, resultsDir })

    expect(queries.getTask(db, task.id)!.runCount).toBe(1)
  })

  it('does not increment runCount when all retries fail', async () => {
    const task = queries.createTask(db, {
      name: 'No Count',
      prompt: 'Fail me',
      triggerType: 'manual',
      maxRuns: 5
    })

    mockExecute.mockResolvedValue({
      stdout: '', stderr: 'rate limit exceeded', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
    })

    await executeTask(task.id, { db, resultsDir })

    expect(queries.getTask(db, task.id)!.runCount).toBe(0)
  })
})

// ─── Concurrency Limiter ──────────────────────────────────────

describe('executeTask - concurrency limiter', () => {
  it('limits concurrent executions to default (3)', async () => {
    // Create 5 tasks — with default max_concurrent_tasks=3, two should queue
    const taskIds: number[] = []
    for (let i = 0; i < 5; i++) {
      taskIds.push(createActiveTask(`Concurrent ${i}`, `Work ${i}`))
    }

    const resolvers: Array<(value: { stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean; sessionId: string | null }) => void> = []

    // Each call creates a promise that we control
    mockExecute.mockImplementation(() => {
      return new Promise(resolve => {
        resolvers.push(resolve)
      })
    })

    // Start all 5 tasks concurrently
    const promises = taskIds.map(id => executeTask(id, { db, resultsDir }))

    // Wait for microtasks to settle
    await new Promise(resolve => setTimeout(resolve, 50))

    // Only 3 should have actually called executeClaudeCode (3 resolvers)
    expect(resolvers.length).toBe(3)

    // Complete first task — should unblock 4th
    resolvers[0]({ stdout: 'done 0', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resolvers.length).toBe(4)

    // Complete second task — should unblock 5th
    resolvers[1]({ stdout: 'done 1', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resolvers.length).toBe(5)

    // Complete remaining tasks
    resolvers[2]({ stdout: 'done 2', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    resolvers[3]({ stdout: 'done 3', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    resolvers[4]({ stdout: 'done 4', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })

    const results = await Promise.all(promises)
    expect(results.every(r => r.success)).toBe(true)
  })

  it('respects max_concurrent_tasks setting', async () => {
    // Set max to 2 instead of default 3
    queries.setSetting(db, 'max_concurrent_tasks', '2')

    const taskIds: number[] = []
    for (let i = 0; i < 4; i++) {
      taskIds.push(createActiveTask(`Concurrent ${i}`, `Work ${i}`))
    }

    const resolvers: Array<(value: { stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean; sessionId: string | null }) => void> = []

    mockExecute.mockImplementation(() => {
      return new Promise(resolve => {
        resolvers.push(resolve)
      })
    })

    const promises = taskIds.map(id => executeTask(id, { db, resultsDir }))

    await new Promise(resolve => setTimeout(resolve, 50))

    // Only 2 should have called executeClaudeCode (not 3)
    expect(resolvers.length).toBe(2)

    // Complete first — should unblock 3rd
    resolvers[0]({ stdout: 'done 0', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resolvers.length).toBe(3)

    // Complete second — should unblock 4th
    resolvers[1]({ stdout: 'done 1', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resolvers.length).toBe(4)

    // Complete remaining
    resolvers[2]({ stdout: 'done 2', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })
    resolvers[3]({ stdout: 'done 3', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null })

    const results = await Promise.all(promises)
    expect(results.every(r => r.success)).toBe(true)

    // Clean up setting so it doesn't affect subsequent tests
    queries.setSetting(db, 'max_concurrent_tasks', '3')
  })

  it('all tasks complete even when some fail (slots released on failure)', async () => {
    // 4 tasks, 3 concurrency — all should eventually complete
    const taskIds: number[] = []
    for (let i = 0; i < 4; i++) {
      taskIds.push(createActiveTask(`Task ${i}`, `Work ${i}`))
    }

    let callCount = 0
    mockExecute.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          stdout: '', stderr: 'error', exitCode: 1, durationMs: 50, timedOut: false, sessionId: null
        })
      }
      return Promise.resolve({
        stdout: 'ok', stderr: '', exitCode: 0, durationMs: 100, timedOut: false, sessionId: null
      })
    })

    const results = await Promise.all(
      taskIds.map(id => executeTask(id, { db, resultsDir }))
    )

    // All should complete (slot released on failure, 4th task unblocked)
    const succeeded = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length
    expect(succeeded).toBe(3)
    expect(failed).toBe(1)
    expect(callCount).toBe(4) // all 4 tasks actually ran
  })
})
