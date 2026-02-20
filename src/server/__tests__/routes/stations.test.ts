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
  describe('POST /api/rooms/:roomId/stations', () => {
    it('creates a station', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'Test Station',
        provider: 'hetzner',
        tier: 'cx22'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('Test Station')
      expect((res.body as any).provider).toBe('hetzner')
      expect((res.body as any).tier).toBe('cx22')
    })

    it('creates a station with optional fields', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'Full Station',
        provider: 'aws',
        tier: 't3.micro',
        region: 'us-east-1',
        config: { instanceType: 't3.micro' }
      })
      expect(res.status).toBe(201)
      expect((res.body as any).region).toBe('us-east-1')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        provider: 'hetzner',
        tier: 'cx22'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if provider missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'No Provider',
        tier: 'cx22'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if tier missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'No Tier',
        provider: 'hetzner'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/rooms/:roomId/stations', () => {
    it('lists stations for a room', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/stations`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/stations/:id', () => {
    it('returns a station', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'FindMe Station',
        provider: 'hetzner',
        tier: 'cx22'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/stations/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('FindMe Station')
    })

    it('returns 404 for missing station', async () => {
      const res = await request(ctx, 'GET', '/api/stations/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/stations/:id', () => {
    it('updates a station', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'UpdateMe Station',
        provider: 'hetzner',
        tier: 'cx22'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/stations/${id}`, {
        status: 'running'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).status).toBe('running')
    })

    it('returns 404 for missing station', async () => {
      const res = await request(ctx, 'PATCH', '/api/stations/99999', {
        name: 'Ghost'
      })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/stations/:id', () => {
    it('deletes a station', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/stations`, {
        name: 'DeleteMe Station',
        provider: 'hetzner',
        tier: 'cx22'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/stations/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })

    it('returns 404 for missing station', async () => {
      const res = await request(ctx, 'DELETE', '/api/stations/99999')
      expect(res.status).toBe(404)
    })
  })
})
