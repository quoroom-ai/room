import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'
import * as queries from '../../../shared/db-queries'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

beforeEach(() => {
  // Clear clerk messages and relevant settings between tests
  ctx.db.prepare("DELETE FROM clerk_messages").run()
  ctx.db.prepare("DELETE FROM settings WHERE key LIKE 'clerk_%'").run()
})

describe('Clerk routes', () => {
  describe('POST /api/clerk/presence', () => {
    it('returns ok and saves clerk_user_last_seen_at', async () => {
      const before = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')
      expect(before).toBeNull()

      const res = await request(ctx, 'POST', '/api/clerk/presence')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const after = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')
      expect(after).toBeTruthy()
      expect(new Date(after!).getTime()).toBeCloseTo(Date.now(), -3)
    })

    it('updates the timestamp on repeated calls', async () => {
      await request(ctx, 'POST', '/api/clerk/presence')
      const first = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')!

      // Small delay to ensure timestamps differ
      await new Promise(r => setTimeout(r, 10))
      await request(ctx, 'POST', '/api/clerk/presence')
      const second = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')!

      expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
    })
  })

  describe('POST /api/clerk/typing', () => {
    it('returns ok and updates clerk_last_user_message_at', async () => {
      const res = await request(ctx, 'POST', '/api/clerk/typing')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const val = queries.getSetting(ctx.db, 'clerk_last_user_message_at')
      expect(val).toBeTruthy()
    })
  })

  describe('GET /api/clerk/messages', () => {
    it('returns empty array when no messages', async () => {
      const res = await request(ctx, 'GET', '/api/clerk/messages')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBe(0)
    })

    it('returns messages after insert', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'Hello Clerk')
      queries.insertClerkMessage(ctx.db, 'assistant', 'Hello keeper')

      const res = await request(ctx, 'GET', '/api/clerk/messages')
      expect(res.status).toBe(200)
      const msgs = res.body as any[]
      expect(msgs.length).toBe(2)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].content).toBe('Hello Clerk')
      expect(msgs[1].role).toBe('assistant')
    })

    it('respects limit query param', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'msg1')
      queries.insertClerkMessage(ctx.db, 'user', 'msg2')
      queries.insertClerkMessage(ctx.db, 'user', 'msg3')

      const res = await request(ctx, 'GET', '/api/clerk/messages?limit=2')
      expect(res.status).toBe(200)
      expect((res.body as any[]).length).toBe(2)
    })
  })

  describe('GET /api/clerk/status', () => {
    it('returns configured=false by default', async () => {
      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(typeof body.configured).toBe('boolean')
      expect(typeof body.commentaryEnabled).toBe('boolean')
      expect(body.commentaryEnabled).toBe(true) // default is enabled
      expect(body.commentaryMode).toBe('auto')
      expect(body.commentaryPace).toBe('light')
      expect(body.model).toBeNull()
      expect(body.apiAuth).toBeDefined()
    })

    it('reflects commentaryEnabled=false after setting it', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', 'false')

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(false)
    })

    it('reflects commentaryMode=light after setting it', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_mode', 'light')

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryMode).toBe('light')
      expect((res.body as any).commentaryPace).toBe('light')
    })

    it('switches commentaryPace to active after presence heartbeat', async () => {
      const before = await request(ctx, 'GET', '/api/clerk/status')
      expect(before.status).toBe(200)
      expect((before.body as any).commentaryPace).toBe('light')

      const presence = await request(ctx, 'POST', '/api/clerk/presence')
      expect(presence.status).toBe(200)

      const after = await request(ctx, 'GET', '/api/clerk/status')
      expect(after.status).toBe(200)
      expect((after.body as any).commentaryPace).toBe('active')
    })

    it('treats recent clerk_last_user_message_at as active presence', async () => {
      queries.setSetting(ctx.db, 'clerk_last_user_message_at', new Date().toISOString())

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryPace).toBe('active')
    })
  })

  describe('PUT /api/clerk/settings', () => {
    it('updates commentaryEnabled', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryEnabled: false })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(false)

      const stored = queries.getSetting(ctx.db, 'clerk_commentary_enabled')
      expect(stored).toBe('false')
    })

    it('re-enables commentaryEnabled', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', 'false')

      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryEnabled: true })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(true)
    })

    it('updates commentaryMode', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryMode: 'light' })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryMode).toBe('light')

      const stored = queries.getSetting(ctx.db, 'clerk_commentary_mode')
      expect(stored).toBe('light')
    })

    it('rejects invalid commentaryMode', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryMode: 'fast' })
      expect(res.status).toBe(400)
      expect(String((res.body as any).error || '')).toContain('commentaryMode')
    })

    it('updates model', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { model: 'claude' })
      expect(res.status).toBe(200)
      expect((res.body as any).model).toBe('claude')

      const stored = queries.getSetting(ctx.db, 'clerk_model')
      expect(stored).toBe('claude')
    })

    it('accepts empty body without error', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', {})
      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/clerk/reset', () => {
    it('clears messages and session', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'something')
      queries.setSetting(ctx.db, 'clerk_session_id', 'abc123')

      const res = await request(ctx, 'POST', '/api/clerk/reset')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const messages = queries.listClerkMessages(ctx.db)
      expect(messages.length).toBe(0)

      const sessionId = queries.getSetting(ctx.db, 'clerk_session_id')
      expect(sessionId).toBeFalsy()
    })
  })

  describe('GET /api/clerk/usage', () => {
    it('returns usage stats', async () => {
      const res = await request(ctx, 'GET', '/api/clerk/usage')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.total).toBeDefined()
      expect(body.today).toBeDefined()
      expect(body.bySource).toBeDefined()
      expect(body.bySource.chat).toBeDefined()
      expect(body.bySource.commentary).toBeDefined()
    })
  })
})
