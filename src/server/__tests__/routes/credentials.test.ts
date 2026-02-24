import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let roomId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'CredentialRoom' })
  roomId = (res.body as any).room.id
})

afterAll(() => {
  ctx.close()
})

describe('Credential routes', () => {
  describe('POST /api/rooms/:roomId/credentials', () => {
    it('creates a credential', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'API Key',
        value: 'sk-test-123'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('API Key')
      expect((res.body as any).valueEncrypted).toBe('***')
    })

    it('creates a credential with type', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'GitHub Token',
        type: 'api_key',
        value: 'ghp_test123'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).type).toBe('api_key')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        value: 'some-value'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if value missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'No Value'
      })
      expect(res.status).toBe(400)
    })

    it('upserts by room and name instead of creating duplicates', async () => {
      const first = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'openai_api_key',
        type: 'api_key',
        value: 'sk-old'
      })
      expect(first.status).toBe(201)

      const second = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'openai_api_key',
        type: 'api_key',
        value: 'sk-new'
      })
      expect(second.status).toBe(201)
      expect((second.body as any).id).toBe((first.body as any).id)

      const list = await request(ctx, 'GET', `/api/rooms/${roomId}/credentials`)
      expect(list.status).toBe(200)
      const openAiCreds = (list.body as any[]).filter(c => c.name === 'openai_api_key')
      expect(openAiCreds).toHaveLength(1)
    })
  })

  describe('GET /api/rooms/:roomId/credentials', () => {
    it('lists credentials for a room', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/credentials`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/credentials/:id', () => {
    it('returns a credential', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'FindMe Credential',
        value: 'secret-value'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/credentials/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('FindMe Credential')
      expect((res.body as any).valueEncrypted).toBe('***')
    })

    it('returns 404 for missing credential', async () => {
      const res = await request(ctx, 'GET', '/api/credentials/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/credentials/:id', () => {
    it('deletes a credential', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/credentials`, {
        name: 'DeleteMe Credential',
        value: 'delete-this'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/credentials/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })

    it('returns 404 for missing credential', async () => {
      const res = await request(ctx, 'DELETE', '/api/credentials/99999')
      expect(res.status).toBe(404)
    })
  })
})
