import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, requestNoAuth, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Room routes', () => {
  describe('POST /api/rooms', () => {
    it('creates a room', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', {
        name: 'testroom',
        goal: 'Test goal'
      })
      expect(res.status).toBe(201)
      const data = res.body as any
      expect(data.room.name).toBe('testroom')
      expect(data.queen).toBeDefined()
      expect(data.rootGoal.description).toBe('Test goal')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { goal: 'No name' })
      expect(res.status).toBe(400)
    })

    it('returns 400 if name contains spaces', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { name: 'my room' })
      expect(res.status).toBe(400)
      expect((res.body as any).error).toBe('name must be a single word')
    })

    it('lowercases the room name', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { name: 'MyRoom' })
      expect(res.status).toBe(201)
      expect((res.body as any).room.name).toBe('myroom')
    })

    it('rejects unauthenticated requests', async () => {
      const res = await requestNoAuth(ctx, 'POST', '/api/rooms')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/rooms', () => {
    it('lists rooms', async () => {
      const res = await request(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBeGreaterThan(0)
    })
  })

  describe('GET /api/rooms/:id', () => {
    it('returns a room by id', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'GetById' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('getbyid')
    })

    it('returns 404 for missing room', async () => {
      const res = await request(ctx, 'GET', '/api/rooms/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/rooms/:id/status', () => {
    it('returns room status', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'StatusRoom', goal: 'Test' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/status`)
      expect(res.status).toBe(200)
      const data = res.body as any
      expect(data.room).toBeDefined()
      expect(data.workers).toBeDefined()
      expect(data.activeGoals).toBeDefined()
      expect(data.pendingDecisions).toBeDefined()
    })
  })

  describe('GET /api/rooms/:id/activity', () => {
    it('returns activity list', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'ActivityRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/activity`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/rooms/:id/queen', () => {
    it('returns subscription auth mode for default queen model', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'QueenAuthDefault' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/queen`)
      expect(res.status).toBe(200)
      const data = res.body as any
      expect(data.auth).toMatchObject({
        provider: 'claude_subscription',
        mode: 'subscription',
      })
      expect(typeof data.auth.ready).toBe('boolean')
    })

    it('returns api auth readiness for OpenAI model and room credential', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'QueenAuthOpenAI' })
      const roomId = (createRes.body as any).room.id
      const queenId = (createRes.body as any).queen.id

      await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'openai:gpt-4o-mini' })
      const beforeCred = await request(ctx, 'GET', `/api/rooms/${roomId}/queen`)
      expect(beforeCred.status).toBe(200)
      expect((beforeCred.body as any).auth).toMatchObject({
        provider: 'openai_api',
        mode: 'api',
        hasCredential: false,
        ready: false
      })

      const credRes = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'openai_api_key',
        type: 'api_key',
        value: 'sk-room-value'
      })
      expect(credRes.status).toBe(201)

      const afterCred = await request(ctx, 'GET', `/api/rooms/${roomId}/queen`)
      expect(afterCred.status).toBe(200)
      expect((afterCred.body as any).auth).toMatchObject({
        provider: 'openai_api',
        mode: 'api',
        hasCredential: true,
        ready: true
      })
    })

    it('returns subscription auth mode for codex model', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'QueenAuthCodex' })
      const roomId = (createRes.body as any).room.id
      const queenId = (createRes.body as any).queen.id

      await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'codex' })
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/queen`)
      expect(res.status).toBe(200)
      expect((res.body as any).auth).toMatchObject({
        provider: 'codex_subscription',
        mode: 'subscription',
      })
      expect(typeof (res.body as any).auth.ready).toBe('boolean')
    })
  })

  describe('POST /api/rooms/:id/pause', () => {
    it('pauses a room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'PauseRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/pause`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/rooms/:id/restart', () => {
    it('restarts a paused room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'RestartRoom' })
      const roomId = (createRes.body as any).room.id

      await request(ctx, 'POST', `/api/rooms/${roomId}/pause`)
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/restart`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('DELETE /api/rooms/:id', () => {
    it('deletes a room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'DeleteRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'DELETE', `/api/rooms/${roomId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const getRes = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect(getRes.status).toBe(404)
    })
  })

  describe('PATCH /api/rooms/:id queenNickname', () => {
    it('creates a room with an auto-generated queenNickname', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { name: 'NickRoom' })
      expect(res.status).toBe(201)
      const room = (res.body as any).room
      expect(typeof room.queenNickname).toBe('string')
      expect(room.queenNickname.length).toBeGreaterThan(0)
    })

    it('updates queenNickname via PATCH', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'PatchNick' })
      const roomId = (createRes.body as any).room.id

      const patchRes = await request(ctx, 'PATCH', `/api/rooms/${roomId}`, { queenNickname: 'Stella' })
      expect(patchRes.status).toBe(200)

      const getRes = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect((getRes.body as any).queenNickname).toBe('Stella')
    })

    it('strips whitespace from queenNickname', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'SpaceNick' })
      const roomId = (createRes.body as any).room.id

      const patchRes = await request(ctx, 'PATCH', `/api/rooms/${roomId}`, { queenNickname: '  Luna  ' })
      expect(patchRes.status).toBe(200)

      const getRes = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect((getRes.body as any).queenNickname).toBe('Luna')
    })
  })
})
