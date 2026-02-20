import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, requestAsUser, requestNoAuth, type TestContext } from './helpers/test-server'
import { updateRoom, listRooms } from '../../shared/db-queries'
import { createRoom as createRoomFull } from '../../shared/room'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Server integration', () => {
  describe('Auth', () => {
    it('GET /api/auth/handshake returns user token (not agent token)', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/handshake')
      expect(res.status).toBe(200)
      expect((res.body as any).token).toBe(ctx.userToken)
      expect((res.body as any).token).not.toBe(ctx.token)
    })

    it('GET /api/auth/handshake rejects non-local origins', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/handshake', {
        Origin: 'https://app.quoroom.ai'
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/auth/verify succeeds with agent token', async () => {
      const res = await request(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
      expect((res.body as any).role).toBe('agent')
    })

    it('GET /api/auth/verify succeeds with user token', async () => {
      const res = await requestAsUser(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
      expect((res.body as any).role).toBe('user')
    })

    it('GET /api/auth/verify fails without token', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(401)
    })

    it('rejects unauthenticated API requests', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(401)
    })
  })

  describe('Role-based access (auto mode)', () => {
    it('agent can create resources in auto mode', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { name: 'Test Room' })
      expect(res.status).toBe(201)
    })

    it('user can read resources in auto mode', async () => {
      const res = await requestAsUser(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(200)
    })

    it('user cannot create tasks in auto mode', async () => {
      const res = await requestAsUser(ctx, 'POST', '/api/tasks', {
        prompt: 'test task',
        cronExpression: null
      })
      expect(res.status).toBe(403)
    })

    it('user can change settings in auto mode', async () => {
      const res = await requestAsUser(ctx, 'PUT', '/api/settings/test_key', { value: 'test_value' })
      expect(res.status).toBe(200)
    })
  })

  describe('Role-based access (semi mode)', () => {
    it('user can create tasks in semi mode', async () => {
      // Create a room in semi mode
      const result = createRoomFull(ctx.db, { name: 'Semi Test Room' })
      updateRoom(ctx.db, result.room.id, { autonomyMode: 'semi' })

      const res = await requestAsUser(ctx, 'POST', '/api/tasks', {
        prompt: 'semi test task',
        cronExpression: null
      })
      expect(res.status).toBe(201)

      // Switch back to auto for other tests
      updateRoom(ctx.db, result.room.id, { autonomyMode: 'auto' })
    })
  })

  describe('404 handling', () => {
    it('returns 404 for unknown API routes', async () => {
      const res = await request(ctx, 'GET', '/api/nonexistent')
      expect(res.status).toBe(404)
    })

    it('returns 404 for non-API routes', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/something')
      expect(res.status).toBe(404)
    })
  })

  describe('CORS preflight', () => {
    it('handles OPTIONS requests', async () => {
      const res = await requestNoAuth(ctx, 'OPTIONS', '/api/rooms')
      expect(res.status).toBe(204)
    })
  })
})
