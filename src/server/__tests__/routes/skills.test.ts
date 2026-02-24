import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let roomId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'SkillRoom' })
  roomId = (res.body as any).room.id
})

afterAll(() => {
  ctx.close()
})

describe('Skill routes', () => {
  describe('POST /api/skills', () => {
    it('creates a skill', async () => {
      const res = await request(ctx, 'POST', '/api/skills', {
        roomId,
        name: 'Test Skill',
        content: 'Do something useful'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('Test Skill')
      expect((res.body as any).content).toBe('Do something useful')
    })

    it('returns 400 if roomId missing', async () => {
      const res = await request(ctx, 'POST', '/api/skills', {
        name: 'NoRoom',
        content: 'test'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/skills', {
        roomId,
        content: 'test'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if content missing', async () => {
      const res = await request(ctx, 'POST', '/api/skills', {
        roomId,
        name: 'NoContent'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/skills', () => {
    it('lists all skills', async () => {
      const res = await request(ctx, 'GET', '/api/skills')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('filters by roomId', async () => {
      const res = await request(ctx, 'GET', `/api/skills?roomId=${roomId}`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/skills/:id', () => {
    it('returns a skill', async () => {
      const createRes = await request(ctx, 'POST', '/api/skills', {
        roomId,
        name: 'FindMe Skill',
        content: 'content'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/skills/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('FindMe Skill')
    })

    it('returns 404 for missing skill', async () => {
      const res = await request(ctx, 'GET', '/api/skills/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/skills/:id', () => {
    it('updates a skill', async () => {
      const createRes = await request(ctx, 'POST', '/api/skills', {
        roomId,
        name: 'UpdateMe Skill',
        content: 'old'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/skills/${id}`, {
        content: 'new content'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).content).toBe('new content')
    })
  })

  describe('DELETE /api/skills/:id', () => {
    it('deletes a skill', async () => {
      const createRes = await request(ctx, 'POST', '/api/skills', {
        roomId,
        name: 'DeleteMe Skill',
        content: 'content'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/skills/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })
})
