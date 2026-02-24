import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

const { mockExecuteAgent } = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn()
}))

vi.mock('../../../shared/agent-executor', () => ({
  executeAgent: mockExecuteAgent
}))

import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

beforeEach(() => {
  mockExecuteAgent.mockReset()
  mockExecuteAgent.mockResolvedValue({
    output: 'Mocked assistant response',
    exitCode: 0,
    durationMs: 5,
    sessionId: 'session-1',
    timedOut: false
  })
})

afterEach(() => {
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

describe('Chat routes', () => {
  it('prefers room OpenAI credential over env key when sending queen chat', async () => {
    const createRoom = await request(ctx, 'POST', '/api/rooms', { name: 'ChatOpenAiCredRoom' })
    const roomId = (createRoom.body as any).room.id
    const queenId = (createRoom.body as any).queen.id

    const patchRes = await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'openai:gpt-4o-mini' })
    expect(patchRes.status).toBe(200)

    process.env.OPENAI_API_KEY = 'sk-env-value'
    const credRes = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
      name: 'openai_api_key',
      type: 'api_key',
      value: 'sk-room-value'
    })
    expect(credRes.status).toBe(201)

    const chatRes = await request(ctx, 'POST', `/api/rooms/${roomId}/chat`, { message: 'hello queen' })
    expect(chatRes.status).toBe(200)
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1)
    expect(mockExecuteAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai:gpt-4o-mini',
      prompt: 'hello queen',
      apiKey: 'sk-room-value'
    }))
  })

  it('uses env Anthropic key when room credential is missing', async () => {
    const createRoom = await request(ctx, 'POST', '/api/rooms', { name: 'ChatAnthropicEnvRoom' })
    const roomId = (createRoom.body as any).room.id
    const queenId = (createRoom.body as any).queen.id

    const patchRes = await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'anthropic:claude-3-5-sonnet-latest' })
    expect(patchRes.status).toBe(200)

    process.env.ANTHROPIC_API_KEY = 'ak-env-value'
    const chatRes = await request(ctx, 'POST', `/api/rooms/${roomId}/chat`, { message: 'need advice' })
    expect(chatRes.status).toBe(200)
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1)
    expect(mockExecuteAgent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'anthropic:claude-3-5-sonnet-latest',
      prompt: 'need advice',
      apiKey: 'ak-env-value'
    }))
  })

  it('sends no api key for subscription model and reuses chat session id', async () => {
    const createRoom = await request(ctx, 'POST', '/api/rooms', { name: 'ChatCodexRoom' })
    const roomId = (createRoom.body as any).room.id
    const queenId = (createRoom.body as any).queen.id

    const patchRes = await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'codex' })
    expect(patchRes.status).toBe(200)

    mockExecuteAgent
      .mockResolvedValueOnce({
        output: 'First response',
        exitCode: 0,
        durationMs: 5,
        sessionId: 'codex-session-42',
        timedOut: false
      })
      .mockResolvedValueOnce({
        output: 'Second response',
        exitCode: 0,
        durationMs: 5,
        sessionId: 'codex-session-42',
        timedOut: false
      })

    const first = await request(ctx, 'POST', `/api/rooms/${roomId}/chat`, { message: 'first' })
    expect(first.status).toBe(200)
    const second = await request(ctx, 'POST', `/api/rooms/${roomId}/chat`, { message: 'second' })
    expect(second.status).toBe(200)

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2)
    expect(mockExecuteAgent.mock.calls[0][0]).toMatchObject({
      model: 'codex',
      prompt: 'first'
    })
    expect(mockExecuteAgent.mock.calls[0][0].apiKey).toBeUndefined()
    expect(mockExecuteAgent.mock.calls[1][0]).toMatchObject({
      model: 'codex',
      prompt: 'second',
      resumeSessionId: 'codex-session-42'
    })
    expect(mockExecuteAgent.mock.calls[1][0].apiKey).toBeUndefined()
  })
})
