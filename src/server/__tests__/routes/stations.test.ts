import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let roomId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'StationRoom' })
  roomId = (res.body as any).room.id
})

afterAll(() => {
  ctx.close()
})

describe('Station routes', () => {
  describe('GET /api/rooms/:roomId/stations', () => {
    it('lists stations for a room (empty)', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/stations`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/stations/:id', () => {
    it('returns 404 for missing station', async () => {
      const res = await request(ctx, 'GET', '/api/stations/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('POST/PATCH/DELETE removed', () => {
    it('POST /api/rooms/:roomId/stations returns 404 (removed)', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'test', provider: 'mock', tier: 'micro'
      })
      expect(res.status).toBe(404)
    })

    it('PATCH /api/stations/:id returns 404 (removed)', async () => {
      const res = await request(ctx, 'PATCH', '/api/stations/1', { status: 'running' })
      expect(res.status).toBe(404)
    })

    it('DELETE /api/stations/:id returns 404 (removed)', async () => {
      const res = await request(ctx, 'DELETE', '/api/stations/1')
      expect(res.status).toBe(404)
    })
  })
})
