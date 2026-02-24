import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'
import * as queries from '../../../shared/db-queries'

let ctx: TestContext
let roomId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'MessageRoom' })
  roomId = (res.body as any).room.id
})

afterAll(() => {
  ctx.close()
})

/** Helper to create a message directly in the DB (no POST /api/rooms/:id/messages route) */
function createMessage(
  subject: string,
  body: string,
  opts?: { fromRoomId?: string; toRoomId?: string }
) {
  return queries.createRoomMessage(ctx.db, roomId, 'inbound', subject, body, opts)
}

describe('Room message routes', () => {
  describe('GET /api/rooms/:roomId/messages', () => {
    it('lists messages for a room', async () => {
      createMessage('Hello', 'World')

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/messages`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBeGreaterThan(0)
    })

    it('filters by status', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/messages?status=unread`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/messages/:id', () => {
    it('returns a message', async () => {
      const msg = createMessage('FindMe Subject', 'FindMe Body')

      const res = await request(ctx, 'GET', `/api/messages/${msg.id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).subject).toBe('FindMe Subject')
      expect((res.body as any).body).toBe('FindMe Body')
    })

    it('returns 404 for missing message', async () => {
      const res = await request(ctx, 'GET', '/api/messages/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/rooms/:roomId/messages/:id/read', () => {
    it('marks a message as read', async () => {
      const msg = createMessage('ReadMe Subject', 'ReadMe Body')

      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/messages/${msg.id}/read`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      // Verify it was marked as read
      const getRes = await request(ctx, 'GET', `/api/messages/${msg.id}`)
      expect((getRes.body as any).status).toBe('read')
    })
  })

  describe('POST /api/messages/:id/reply', () => {
    it('creates outbound reply and marks original as replied', async () => {
      const msg = createMessage('Need Reply', 'Original message', { fromRoomId: 'remote-room-1' })

      const res = await request(ctx, 'POST', `/api/messages/${msg.id}/reply`, {
        body: 'Reply body'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).direction).toBe('outbound')
      expect((res.body as any).toRoomId).toBe('remote-room-1')
      expect((res.body as any).subject).toBe('Re: Need Reply')

      const original = await request(ctx, 'GET', `/api/messages/${msg.id}`)
      expect((original.body as any).status).toBe('replied')
    })

    it('returns 400 when reply destination cannot be determined', async () => {
      const msg = createMessage('No Sender', 'Cannot infer destination')

      const res = await request(ctx, 'POST', `/api/messages/${msg.id}/reply`, {
        body: 'Reply body'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /api/messages/:id', () => {
    it('deletes a message', async () => {
      const msg = createMessage('DeleteMe Subject', 'DeleteMe Body')

      const res = await request(ctx, 'DELETE', `/api/messages/${msg.id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      // Verify it was deleted
      const getRes = await request(ctx, 'GET', `/api/messages/${msg.id}`)
      expect(getRes.status).toBe(404)
    })
  })
})
