import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoom } from '../room'

// Mock agent-executor
vi.mock('../agent-executor', () => ({
  executeAgent: vi.fn()
}))

// Mock rate-limit sleep to resolve instantly (but keep detectRateLimit real)
vi.mock('../rate-limit', async () => {
  const actual = await vi.importActual('../rate-limit') as Record<string, unknown>
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined)
  }
})

import { runCycle, startAgentLoop, pauseAgent, triggerAgent, getAgentState, isAgentRunning, _stopAllLoops, RateLimitError } from '../agent-loop'
import { executeAgent } from '../agent-executor'
import { sleep } from '../rate-limit'

const mockExecuteAgent = vi.mocked(executeAgent)
const mockSleep = vi.mocked(sleep)

let db: Database.Database
let roomId: number
let queenId: number

beforeEach(() => {
  db = initTestDb()
  vi.clearAllMocks()

  const result = createRoom(db, { name: 'Test Room', goal: 'Make money' })
  roomId = result.room.id
  queenId = result.queen.id

  mockExecuteAgent.mockResolvedValue({
    output: 'I analyzed the situation and will focus on building a SaaS product.',
    exitCode: 0,
    durationMs: 5000,
    sessionId: 'session-1',
    timedOut: false
  })
})

afterEach(() => {
  _stopAllLoops()
})

describe('runCycle', () => {
  it('executes a full observe-think-act-persist cycle', async () => {
    const worker = queries.getWorker(db, queenId)!
    const output = await runCycle(db, roomId, worker)

    expect(output).toContain('SaaS product')
    expect(mockExecuteAgent).toHaveBeenCalledOnce()

    // Should have called with proper prompt containing room context
    const callArgs = mockExecuteAgent.mock.calls[0][0]
    expect(callArgs.prompt).toContain('Make money')
    expect(callArgs.systemPrompt).toContain(worker.systemPrompt)

    // Agent state should be idle after cycle
    expect(queries.getWorker(db, queenId)!.agentState).toBe('idle')

    // Activity should be logged
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.some(a => a.summary.includes('Agent cycle completed'))).toBe(true)
  })

  it('includes active goals in context', async () => {
    const worker = queries.getWorker(db, queenId)!
    await runCycle(db, roomId, worker)

    const callArgs = mockExecuteAgent.mock.calls[0][0]
    expect(callArgs.prompt).toContain('Active Goals')
    expect(callArgs.prompt).toContain('Make money')
  })

  it('includes pending decisions in context', async () => {
    queries.createDecision(db, roomId, queenId, 'Build SaaS?', 'strategy')

    const worker = queries.getWorker(db, queenId)!
    await runCycle(db, roomId, worker)

    const callArgs = mockExecuteAgent.mock.calls[0][0]
    expect(callArgs.prompt).toContain('Pending Proposals')
    expect(callArgs.prompt).toContain('Build SaaS?')
  })

  it('includes pending escalations in context', async () => {
    const w2 = queries.createWorker(db, { name: 'Worker', systemPrompt: 'w', roomId })
    queries.createEscalation(db, roomId, w2.id, 'How should I proceed?', queenId)

    const worker = queries.getWorker(db, queenId)!
    await runCycle(db, roomId, worker)

    const callArgs = mockExecuteAgent.mock.calls[0][0]
    expect(callArgs.prompt).toContain('Messages from Other Workers')
    expect(callArgs.prompt).toContain('How should I proceed?')
  })

  it('uses worker model for execution', async () => {
    queries.updateWorker(db, queenId, { model: 'openai:gpt-4o-mini' } as Parameters<typeof queries.updateWorker>[2])

    const worker = queries.getWorker(db, queenId)!
    await runCycle(db, roomId, worker)

    expect(mockExecuteAgent.mock.calls[0][0].model).toBe('openai:gpt-4o-mini')
  })

  it('injects matching skills into system prompt', async () => {
    queries.createSkill(db, roomId, 'Money Making', 'Focus on revenue.', {
      activationContext: ['money', 'revenue'],
      autoActivate: true
    })

    const worker = queries.getWorker(db, queenId)!
    await runCycle(db, roomId, worker)

    const callArgs = mockExecuteAgent.mock.calls[0][0]
    expect(callArgs.systemPrompt).toContain('Money Making')
    expect(callArgs.systemPrompt).toContain('Focus on revenue.')
  })

  it('throws RateLimitError when executor returns rate limit response', async () => {
    mockExecuteAgent.mockResolvedValue({
      output: 'Error: 429 rate_limit_error: too many requests',
      exitCode: 1,
      durationMs: 100,
      sessionId: null,
      timedOut: false
    })

    const worker = queries.getWorker(db, queenId)!
    await expect(runCycle(db, roomId, worker)).rejects.toThrow(RateLimitError)
  })

  it('does not throw for non-rate-limit errors', async () => {
    mockExecuteAgent.mockResolvedValue({
      output: 'Some generic error occurred',
      exitCode: 1,
      durationMs: 100,
      sessionId: null,
      timedOut: false
    })

    const worker = queries.getWorker(db, queenId)!
    // Should not throw — non-rate-limit errors are just returned as output
    const output = await runCycle(db, roomId, worker)
    expect(output).toContain('generic error')
  })

  it('does not throw for timeout errors', async () => {
    mockExecuteAgent.mockResolvedValue({
      output: 'rate_limit_error',
      exitCode: 1,
      durationMs: 300000,
      sessionId: null,
      timedOut: true
    })

    const worker = queries.getWorker(db, queenId)!
    const output = await runCycle(db, roomId, worker)
    expect(output).toContain('rate_limit_error')
  })
})

describe('startAgentLoop', () => {
  it('runs cycles continuously until paused', async () => {
    let callCount = 0
    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      if (callCount >= 3) {
        // Pause after 3 cycles
        pauseAgent(db, queenId)
      }
      return {
        output: `Cycle ${callCount}`,
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(3)
    expect(isAgentRunning(queenId)).toBe(false)
  })

  it('enters rate_limited state and waits on rate limit', async () => {
    let callCount = 0
    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // First call: rate limited
        return {
          output: 'Error: 429 rate_limit_error',
          exitCode: 1,
          durationMs: 50,
          sessionId: null,
          timedOut: false
        }
      }
      // Second call: success, then stop
      pauseAgent(db, queenId)
      return {
        output: 'Success after rate limit',
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(2)
    // sleep was called for rate limit wait + gap waits
    expect(mockSleep).toHaveBeenCalled()

    // Activity should log the rate limit event
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.some(a => a.summary.includes('rate limited'))).toBe(true)
  })

  it('stops when room is no longer active', async () => {
    let callCount = 0
    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      if (callCount >= 2) {
        // Pause the room after 2 cycles
        queries.updateRoom(db, roomId, { status: 'paused' })
      }
      return {
        output: `Cycle ${callCount}`,
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(2)
  })

  it('continues after non-rate-limit errors', async () => {
    let callCount = 0
    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('Connection failed')
      }
      if (callCount >= 3) {
        pauseAgent(db, queenId)
      }
      return {
        output: `Cycle ${callCount}`,
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(3)
    // Error should be logged
    const activity = queries.getRoomActivity(db, roomId)
    expect(activity.some(a => a.summary.includes('cycle error'))).toBe(true)
  })

  it('skips if already running', async () => {
    let callCount = 0
    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      // Try to start again while running — should be a no-op
      await startAgentLoop(db, roomId, queenId)
      pauseAgent(db, queenId)
      return {
        output: 'done',
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(1) // Only one cycle, not two
  })
})

describe('triggerAgent', () => {
  it('aborts rate limit wait when triggered', async () => {
    let callCount = 0
    mockSleep.mockImplementation(async (_ms, signal) => {
      if (callCount === 1 && signal) {
        // During rate limit wait, simulate trigger by aborting
        triggerAgent(db, roomId, queenId)
        // The abort should cause sleep to reject
        throw new Error('Rate limit wait aborted')
      }
    })

    mockExecuteAgent.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          output: 'Error: 429 rate_limit_error',
          exitCode: 1,
          durationMs: 50,
          sessionId: null,
          timedOut: false
        }
      }
      pauseAgent(db, queenId)
      return {
        output: 'Resumed after trigger',
        exitCode: 0,
        durationMs: 100,
        sessionId: null,
        timedOut: false
      }
    })

    await startAgentLoop(db, roomId, queenId)

    expect(callCount).toBe(2)
  })

  it('starts loop if not running', () => {
    expect(isAgentRunning(queenId)).toBe(false)
    // triggerAgent on non-running agent should start the loop
    triggerAgent(db, roomId, queenId)
    // It fires async, so just verify it doesn't throw
  })
})

describe('pauseAgent', () => {
  it('sets agent state to idle', () => {
    queries.updateAgentState(db, queenId, 'thinking')
    pauseAgent(db, queenId)
    expect(queries.getWorker(db, queenId)!.agentState).toBe('idle')
  })
})

describe('getAgentState', () => {
  it('returns current agent state', () => {
    expect(getAgentState(db, queenId)).toBe('idle')
    queries.updateAgentState(db, queenId, 'thinking')
    expect(getAgentState(db, queenId)).toBe('thinking')
  })

  it('returns idle for nonexistent worker', () => {
    expect(getAgentState(db, 999)).toBe('idle')
  })

  it('supports rate_limited state', () => {
    queries.updateAgentState(db, queenId, 'rate_limited')
    expect(getAgentState(db, queenId)).toBe('rate_limited')
  })
})

describe('isAgentRunning', () => {
  it('returns false for non-running agent', () => {
    expect(isAgentRunning(queenId)).toBe(false)
  })
})
