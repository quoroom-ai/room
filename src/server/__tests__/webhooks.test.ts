import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'

vi.mock('../runtime', () => ({
  runTaskNow: vi.fn(() => ({ started: true }))
}))

vi.mock('../../shared/agent-loop', () => ({
  triggerAgent: vi.fn()
}))

import { handleWebhookRequest } from '../webhooks'
import { runTaskNow } from '../runtime'
import { triggerAgent } from '../../shared/agent-loop'

const mockRunTaskNow = vi.mocked(runTaskNow)
const mockTriggerAgent = vi.mocked(triggerAgent)

/** Valid 32-char hex token */
function tok(char = 'a'): string {
  return char.repeat(32)
}

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
  mockRunTaskNow.mockReset()
  mockRunTaskNow.mockReturnValue({ started: true })
  mockTriggerAgent.mockReset()
})

afterEach(() => {
  db.close()
})

// ─────────────────────────────────────────────────────────────────────────────
// Path routing
// ─────────────────────────────────────────────────────────────────────────────

describe('path routing', () => {
  it('returns 404 for unknown hook type', async () => {
    const res = await handleWebhookRequest(`/api/hooks/other/${tok()}`, null, db)
    expect(res.status).toBe(404)
  })

  it('returns 404 when token is shorter than 32 chars', async () => {
    const res = await handleWebhookRequest('/api/hooks/task/abc123', null, db)
    expect(res.status).toBe(404)
  })

  it('returns 404 when token contains non-hex chars', async () => {
    const res = await handleWebhookRequest('/api/hooks/task/' + 'g'.repeat(32), null, db)
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task webhook
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/hooks/task/:token', () => {
  it('returns 401 for a token not in the database', async () => {
    const res = await handleWebhookRequest(`/api/hooks/task/${tok()}`, null, db)
    expect(res.status).toBe(401)
    expect((res.data as Record<string, string>).error).toMatch(/invalid/i)
  })

  it('returns 409 when the task is paused', async () => {
    const token = tok()
    const task = queries.createTask(db, { name: 'T', prompt: 'p', triggerType: 'webhook', webhookToken: token })
    queries.pauseTask(db, task.id)

    const res = await handleWebhookRequest(`/api/hooks/task/${token}`, null, db)
    expect(res.status).toBe(409)
    expect((res.data as Record<string, string>).error).toMatch(/paused/i)
  })

  it('returns 202 with ok and taskId on success', async () => {
    const token = tok()
    const task = queries.createTask(db, { name: 'T', prompt: 'p', triggerType: 'webhook', webhookToken: token })

    const res = await handleWebhookRequest(`/api/hooks/task/${token}`, null, db)
    expect(res.status).toBe(202)
    expect((res.data as Record<string, unknown>).ok).toBe(true)
    expect((res.data as Record<string, unknown>).taskId).toBe(task.id)
  })

  it('returns 409 when runTaskNow reports already running', async () => {
    const token = tok()
    queries.createTask(db, { name: 'T', prompt: 'p', triggerType: 'webhook', webhookToken: token })
    mockRunTaskNow.mockReturnValueOnce({ started: false, reason: 'Task is already running' })

    const res = await handleWebhookRequest(`/api/hooks/task/${token}`, null, db)
    expect(res.status).toBe(409)
    expect((res.data as Record<string, string>).error).toMatch(/already running/i)
  })

  it('calls runTaskNow with the correct task id', async () => {
    const token = tok()
    const task = queries.createTask(db, { name: 'T', prompt: 'p', triggerType: 'webhook', webhookToken: token })

    await handleWebhookRequest(`/api/hooks/task/${token}`, null, db)
    expect(mockRunTaskNow).toHaveBeenCalledWith(db, task.id)
  })

  it('does not call runTaskNow for an invalid token', async () => {
    await handleWebhookRequest(`/api/hooks/task/${tok()}`, null, db)
    expect(mockRunTaskNow).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Queen webhook
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/hooks/queen/:token', () => {
  it('returns 401 for a token not in the database', async () => {
    const res = await handleWebhookRequest(`/api/hooks/queen/${tok()}`, null, db)
    expect(res.status).toBe(401)
    expect((res.data as Record<string, string>).error).toMatch(/invalid/i)
  })

  it('returns 409 when room is paused', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token, status: 'paused' })

    const res = await handleWebhookRequest(`/api/hooks/queen/${token}`, null, db)
    expect(res.status).toBe(409)
    expect((res.data as Record<string, string>).error).toMatch(/paused/i)
  })

  it('returns 409 when room is stopped', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token, status: 'stopped' })

    const res = await handleWebhookRequest(`/api/hooks/queen/${token}`, null, db)
    expect(res.status).toBe(409)
    expect((res.data as Record<string, string>).error).toMatch(/stopped/i)
  })

  it('returns 202 with ok and roomId on success', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    const res = await handleWebhookRequest(`/api/hooks/queen/${token}`, {}, db)
    expect(res.status).toBe(202)
    expect((res.data as Record<string, unknown>).ok).toBe(true)
    expect((res.data as Record<string, unknown>).roomId).toBe(room.id)
  })

  it('injects a custom message from body into escalations', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, { message: 'Hello queen' }, db)

    const escalations = queries.listEscalations(db, room.id)
    expect(escalations.at(-1)?.question).toBe('Hello queen')
  })

  it('defaults message to "Webhook triggered" when body is null', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, null, db)

    const escalations = queries.listEscalations(db, room.id)
    expect(escalations.at(-1)?.question).toBe('Webhook triggered')
  })

  it('defaults message to "Webhook triggered" when body.message is whitespace', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, { message: '   ' }, db)

    const escalations = queries.listEscalations(db, room.id)
    expect(escalations.at(-1)?.question).toBe('Webhook triggered')
  })

  it('trims whitespace from a custom message', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, { message: '  hi  ' }, db)

    const escalations = queries.listEscalations(db, room.id)
    expect(escalations.at(-1)?.question).toBe('hi')
  })

  it('calls triggerAgent when room has a queen worker', async () => {
    const worker = queries.createWorker(db, { name: 'W', systemPrompt: 'p', model: 'test' })
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token, queenWorkerId: worker.id })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, {}, db)

    expect(mockTriggerAgent).toHaveBeenCalledWith(db, room.id, worker.id)
  })

  it('does not call triggerAgent when room has no queen worker', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, {}, db)

    expect(mockTriggerAgent).not.toHaveBeenCalled()
  })

  it('inserts escalation from keeper context', async () => {
    const room = queries.createRoom(db, 'R')
    const token = tok()
    queries.updateRoom(db, room.id, { webhookToken: token })

    await handleWebhookRequest(`/api/hooks/queen/${token}`, { message: 'Test' }, db)

    const escalations = queries.listEscalations(db, room.id)
    expect(escalations.at(-1)?.fromAgentId).toBeNull()
    expect(escalations.at(-1)?.toAgentId).toBeNull()
  })
})
