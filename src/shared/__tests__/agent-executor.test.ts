import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentExecutionOptions } from '../agent-executor'

// Mock claude-code before importing agent-executor
vi.mock('../claude-code', () => ({
  executeClaudeCode: vi.fn()
}))

// Mock http for Ollama
vi.mock('http', () => {
  const mockRequest = vi.fn()
  return {
    default: { request: mockRequest },
    request: mockRequest
  }
})

import { executeAgent, isOllamaAvailable } from '../agent-executor'
import { executeClaudeCode } from '../claude-code'
import http from 'http'

const mockExecuteClaudeCode = vi.mocked(executeClaudeCode)
const mockHttpRequest = vi.mocked(http.request)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeAgent', () => {
  describe('Claude CLI routing', () => {
    it('routes "claude" model to executeClaudeCode', async () => {
      mockExecuteClaudeCode.mockResolvedValue({
        stdout: 'Hello from Claude',
        stderr: '',
        exitCode: 0,
        durationMs: 1000,
        timedOut: false,
        sessionId: 'session-123'
      })

      const result = await executeAgent({
        model: 'claude',
        prompt: 'Hello',
        systemPrompt: 'Be helpful'
      })

      expect(mockExecuteClaudeCode).toHaveBeenCalledOnce()
      expect(result.output).toBe('Hello from Claude')
      expect(result.exitCode).toBe(0)
      expect(result.sessionId).toBe('session-123')
    })

    it('passes execution options to Claude CLI', async () => {
      mockExecuteClaudeCode.mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
        durationMs: 0, timedOut: false, sessionId: null
      })

      await executeAgent({
        model: 'claude',
        prompt: 'Test',
        maxTurns: 5,
        timeoutMs: 60000,
        resumeSessionId: 'sess-1',
        systemPrompt: 'System',
        allowedTools: 'Read,Write',
        disallowedTools: 'Bash'
      })

      const callArgs = mockExecuteClaudeCode.mock.calls[0]
      expect(callArgs[0]).toBe('Test')
      expect(callArgs[1]).toMatchObject({
        maxTurns: 5,
        timeoutMs: 60000,
        resumeSessionId: 'sess-1',
        systemPrompt: 'System',
        allowedTools: 'Read,Write',
        disallowedTools: 'Bash'
      })
    })
  })

  describe('Ollama routing', () => {
    function setupMockOllamaResponse(response: string, statusCode: number = 200): void {
      const mockRes = {
        statusCode,
        on: vi.fn((event: string, cb: (data?: string) => void) => {
          if (event === 'data') cb(response)
          if (event === 'end') cb()
          return mockRes
        })
      }
      const mockReq = {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn()
      }
      mockHttpRequest.mockImplementation((_opts: unknown, callback: (res: typeof mockRes) => void) => {
        callback(mockRes)
        return mockReq as unknown as ReturnType<typeof http.request>
      })
    }

    it('routes "ollama:llama3" to Ollama HTTP', async () => {
      setupMockOllamaResponse(JSON.stringify({
        message: { content: 'Hello from Ollama' }
      }))

      const result = await executeAgent({
        model: 'ollama:llama3',
        prompt: 'Hello'
      })

      expect(mockExecuteClaudeCode).not.toHaveBeenCalled()
      expect(result.output).toBe('Hello from Ollama')
      expect(result.exitCode).toBe(0)
      expect(result.sessionId).toBeNull() // No session continuity
    })

    it('handles Ollama errors', async () => {
      const mockReq = {
        on: vi.fn((event: string, cb: (err?: Error) => void) => {
          if (event === 'error') cb(new Error('Connection refused'))
          return mockReq
        }),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn()
      }
      mockHttpRequest.mockImplementation(() => mockReq as unknown as ReturnType<typeof http.request>)

      const result = await executeAgent({
        model: 'ollama:llama3',
        prompt: 'Hello'
      })

      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('Connection refused')
    })
  })
})

describe('isOllamaAvailable', () => {
  it('returns true when Ollama responds', async () => {
    const mockRes = {
      statusCode: 200,
      on: vi.fn((event: string, cb: (data?: string) => void) => {
        if (event === 'data') cb('{"models":[]}')
        if (event === 'end') cb()
        return mockRes
      })
    }
    const mockReq = {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    }
    mockHttpRequest.mockImplementation((_opts: unknown, callback: (res: typeof mockRes) => void) => {
      callback(mockRes)
      return mockReq as unknown as ReturnType<typeof http.request>
    })

    expect(await isOllamaAvailable()).toBe(true)
  })

  it('returns false on connection error', async () => {
    const mockReq = {
      on: vi.fn((event: string, cb: (err?: Error) => void) => {
        if (event === 'error') cb(new Error('ECONNREFUSED'))
        return mockReq
      }),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    }
    mockHttpRequest.mockImplementation(() => mockReq as unknown as ReturnType<typeof http.request>)

    expect(await isOllamaAvailable()).toBe(false)
  })
})
