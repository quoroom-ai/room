import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentExecutionOptions } from '../agent-executor'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// Mock claude-code before importing agent-executor
vi.mock('../claude-code', () => ({
  executeClaudeCode: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: vi.fn()
}))

import { executeAgent } from '../agent-executor'
import { executeClaudeCode } from '../claude-code'
import { spawn } from 'child_process'

const mockExecuteClaudeCode = vi.mocked(executeClaudeCode)
const mockSpawn = vi.mocked(spawn)
let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('executeAgent', () => {
  it('throws for unsupported model identifiers', async () => {
    await expect(executeAgent({
      model: 'unknown:model-x',
      prompt: 'hello'
    })).rejects.toThrow('Unsupported model')
  })

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

    it('includes stderr when Claude CLI fails', async () => {
      mockExecuteClaudeCode.mockResolvedValue({
        stdout: '',
        stderr: 'Error: 429 rate_limit_error: Too many requests',
        exitCode: 1,
        durationMs: 100,
        timedOut: false,
        sessionId: null
      })

      const result = await executeAgent({
        model: 'claude',
        prompt: 'Hello'
      })

      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('rate_limit_error')
      expect(result.output).toContain('Too many requests')
    })
  })

  describe('Codex routing', () => {
    function setupMockCodexProcess(lines: string[], exitCode: number = 0): void {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: ReturnType<typeof vi.fn>
      }
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.kill = vi.fn()

      mockSpawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          for (const line of lines) {
            proc.stdout.write(`${line}\n`)
          }
          proc.stdout.end()
          proc.stderr.end()
          proc.emit('close', exitCode)
        })
        return proc as unknown as ReturnType<typeof spawn>
      })
    }

    it('routes "codex" model to Codex CLI and parses json output/session', async () => {
      setupMockCodexProcess([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello from Codex' } })
      ])

      const result = await executeAgent({
        model: 'codex',
        prompt: 'Hello'
      })

      expect(mockSpawn).toHaveBeenCalledOnce()
      const [bin, args] = mockSpawn.mock.calls[0]
      const expectedBin = process.platform === 'win32' ? 'codex.cmd' : 'codex'
      expect(bin).toBe(expectedBin)
      expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', 'Hello'])
      expect(result.output).toBe('Hello from Codex')
      expect(result.exitCode).toBe(0)
      expect(result.sessionId).toBe('thread-123')
    })

    it('captures mcp_tool_call events via onConsoleLog', async () => {
      setupMockCodexProcess([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-456' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Checking memories...' } }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'quoroom',
            tool: 'quoroom_memory_list',
            arguments: {},
            result: { content: [{ type: 'text', text: '{"totalEntities":5}' }] },
            status: 'completed'
          }
        }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Found 5 memories.' } }),
      ])

      const logEntries: Array<{ entryType: string; content: string }> = []
      const result = await executeAgent({
        model: 'codex',
        prompt: 'List memories',
        onConsoleLog: (entry) => logEntries.push(entry),
      })

      expect(result.output).toBe('Checking memories...\n\nFound 5 memories.')
      expect(result.sessionId).toBe('thread-456')

      const toolCalls = logEntries.filter(e => e.entryType === 'tool_call')
      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0].content).toContain('quoroom_memory_list')

      const toolResults = logEntries.filter(e => e.entryType === 'tool_result')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].content).toContain('totalEntities')

      const textEntries = logEntries.filter(e => e.entryType === 'assistant_text')
      expect(textEntries).toHaveLength(2)
    })

    it('uses codex resume command and preserves resume session when no new thread event arrives', async () => {
      setupMockCodexProcess([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Resumed response' } })
      ])

      const result = await executeAgent({
        model: 'codex:gpt-5-codex',
        prompt: 'Continue',
        systemPrompt: 'Be concise',
        resumeSessionId: 'thread-existing'
      })

      expect(mockSpawn).toHaveBeenCalledOnce()
      const [bin, args] = mockSpawn.mock.calls[0]
      const expectedBin = process.platform === 'win32' ? 'codex.cmd' : 'codex'
      expect(bin).toBe(expectedBin)
      expect(args).toEqual([
        'exec',
        'resume',
        '--model',
        'gpt-5-codex',
        '--json',
        '--skip-git-repo-check',
        'thread-existing',
        'System instructions:\nBe concise\n\nUser request:\nContinue'
      ])
      expect(result.output).toBe('Resumed response')
      expect(result.sessionId).toBe('thread-existing')
    })
  })

  describe('API-key providers', () => {
    it('calls OpenAI API and extracts response text', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'OpenAI says hello' } }]
        })
      })

      const result = await executeAgent({
        model: 'openai:gpt-4.1-mini',
        prompt: 'hello',
        systemPrompt: 'test system',
        apiKey: 'sk-room'
      })

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      expect((options as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer sk-room',
        'Content-Type': 'application/json'
      })
      const payload = JSON.parse(((options as RequestInit).body as string))
      expect(payload.model).toBe('gpt-4.1-mini')
      expect(payload.messages).toEqual([
        { role: 'system', content: 'test system' },
        { role: 'user', content: 'hello' }
      ])
      expect(result.exitCode).toBe(0)
      expect(result.output).toBe('OpenAI says hello')
    })

    it('surfaces OpenAI API error message from response body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { message: 'Invalid API key' }
        })
      })

      const result = await executeAgent({
        model: 'openai:gpt-4o-mini',
        prompt: 'hello',
        apiKey: 'sk-invalid'
      })

      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('OpenAI API 401: Invalid API key')
    })

    it('calls Anthropic API and extracts text blocks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'Anthropic says hello' }]
        })
      })

      const result = await executeAgent({
        model: 'anthropic:claude-3-5-sonnet-latest',
        prompt: 'hello',
        apiKey: 'ak-room'
      })

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      expect((options as RequestInit).headers).toMatchObject({
        'x-api-key': 'ak-room',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toBe('Anthropic says hello')
    })

    it('surfaces Anthropic API error message from response body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { message: 'Model not found' }
        })
      })

      const result = await executeAgent({
        model: 'anthropic:bad-model',
        prompt: 'hello',
        apiKey: 'ak-room'
      })

      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('Anthropic API 400: Model not found')
    })

    it('fails fast for OpenAI API model when key is missing', async () => {
      const prev = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        const result = await executeAgent({
          model: 'openai:gpt-4o-mini',
          prompt: 'hello'
        })
        expect(result.exitCode).toBe(1)
        expect(result.output.toLowerCase()).toContain('missing openai api key')
      } finally {
        if (prev != null) process.env.OPENAI_API_KEY = prev
      }
    })

    it('fails fast for Anthropic API model when key is missing', async () => {
      const prev = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const result = await executeAgent({
          model: 'anthropic:claude-3-5-sonnet-latest',
          prompt: 'hello'
        })
        expect(result.exitCode).toBe(1)
        expect(result.output.toLowerCase()).toContain('missing anthropic api key')
      } finally {
        if (prev != null) process.env.ANTHROPIC_API_KEY = prev
      }
    })
  })
})
