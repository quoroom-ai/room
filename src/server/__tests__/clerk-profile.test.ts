import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'

const { mockExecuteAgent } = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn()
}))

vi.mock('../../shared/agent-executor', () => ({
  executeAgent: mockExecuteAgent
}))

import { executeClerkWithFallback } from '../clerk-profile'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
  mockExecuteAgent.mockReset()
})

afterEach(() => {
  db.close()
})

describe('executeClerkWithFallback', () => {
  it('falls back to next model when codex attempt times out', async () => {
    mockExecuteAgent
      .mockResolvedValueOnce({
        output: '',
        exitCode: 124,
        durationMs: 20_000,
        sessionId: null,
        timedOut: true,
        usage: { inputTokens: 120, outputTokens: 0 }
      })
      .mockResolvedValueOnce({
        output: 'Recovered on fallback model',
        exitCode: 0,
        durationMs: 1_200,
        sessionId: 'session-fallback',
        timedOut: false,
        usage: { inputTokens: 80, outputTokens: 30 }
      })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'codex',
      prompt: 'latest room logs',
      systemPrompt: 'commentary'
    })

    expect(result.ok).toBe(true)
    expect(result.model).toBe('claude')
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toHaveLength(1)
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 30 })
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2)
    expect(mockExecuteAgent.mock.calls[0][0]).toMatchObject({ model: 'codex' })
    expect(mockExecuteAgent.mock.calls[1][0]).toMatchObject({ model: 'claude' })
  })

  it('still fails fast on non-transient errors', async () => {
    mockExecuteAgent.mockResolvedValueOnce({
      output: 'Fatal validation error',
      exitCode: 1,
      durationMs: 40,
      sessionId: null,
      timedOut: false,
      usage: { inputTokens: 20, outputTokens: 0 }
    })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'codex',
      prompt: 'do work',
      systemPrompt: 'system'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Fatal validation error')
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1)
  })
})
