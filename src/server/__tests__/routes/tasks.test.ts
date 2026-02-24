import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Task routes', () => {
  describe('POST /api/tasks — webhook trigger', () => {
    it('auto-generates a webhookToken when triggerType is webhook', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Webhook task',
        triggerType: 'webhook'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).webhookToken).toMatch(/^[a-f0-9]{32}$/)
    })

    it('does not generate a webhookToken for non-webhook trigger types', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Manual task',
        triggerType: 'manual'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).webhookToken).toBeNull()
    })

    it('does not generate a webhookToken when triggerType is omitted', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Default task'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).webhookToken).toBeNull()
    })
  })

  describe('PATCH /api/tasks/:id — regenerateWebhookToken', () => {
    it('generates a new webhookToken when regenerateWebhookToken is true', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Regen test',
        triggerType: 'webhook'
      })
      const id = (createRes.body as any).id
      const originalToken = (createRes.body as any).webhookToken as string

      const patchRes = await request(ctx, 'PATCH', `/api/tasks/${id}`, {
        regenerateWebhookToken: true
      })
      expect(patchRes.status).toBe(200)
      const newToken = (patchRes.body as any).webhookToken as string
      expect(newToken).toMatch(/^[a-f0-9]{32}$/)
      expect(newToken).not.toBe(originalToken)
    })

    it('assigns a webhookToken to a task that did not originally have one', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'No token yet'
      })
      const id = (createRes.body as any).id
      expect((createRes.body as any).webhookToken).toBeNull()

      const patchRes = await request(ctx, 'PATCH', `/api/tasks/${id}`, {
        regenerateWebhookToken: true
      })
      expect(patchRes.status).toBe(200)
      expect((patchRes.body as any).webhookToken).toMatch(/^[a-f0-9]{32}$/)
    })
  })

  describe('POST /api/tasks', () => {
    it('creates a task', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Summarize the news',
        name: 'News Summary'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('News Summary')
      expect((res.body as any).prompt).toBe('Summarize the news')
    })

    it('defaults name to prompt prefix', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'A very long task description that exceeds fifty characters for testing'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('A very long task description that exceeds fifty ch')
    })

    it('returns 400 if prompt missing', async () => {
      const res = await request(ctx, 'POST', '/api/tasks', { name: 'No prompt' })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/tasks', () => {
    it('lists tasks', async () => {
      const res = await request(ctx, 'GET', '/api/tasks')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/tasks/:id', () => {
    it('returns a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Find task test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/tasks/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).prompt).toBe('Find task test')
    })

    it('returns 404 for missing task', async () => {
      const res = await request(ctx, 'GET', '/api/tasks/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/tasks/:id', () => {
    it('updates a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Update task test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/tasks/${id}`, {
        name: 'Updated Task Name'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('Updated Task Name')
    })
  })

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Delete task test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/tasks/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/tasks/:id/pause', () => {
    it('pauses a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Pause task test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/tasks/${id}/pause`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/tasks/:id/resume', () => {
    it('resumes a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Resume task test'
      })
      const id = (createRes.body as any).id

      await request(ctx, 'POST', `/api/tasks/${id}/pause`)
      const res = await request(ctx, 'POST', `/api/tasks/${id}/resume`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('GET /api/tasks/:id/runs', () => {
    it('returns runs for a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Runs list test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/tasks/${id}/runs`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('POST /api/tasks/:id/reset-session', () => {
    it('resets session for a task', async () => {
      const createRes = await request(ctx, 'POST', '/api/tasks', {
        prompt: 'Session reset test'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/tasks/${id}/reset-session`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })
})
