import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Memory routes', () => {
  describe('Entities', () => {
    it('creates an entity', async () => {
      const res = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'Test Entity',
        type: 'fact',
        category: 'work'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('Test Entity')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/memory/entities', {})
      expect(res.status).toBe(400)
    })

    it('lists entities', async () => {
      const res = await request(ctx, 'GET', '/api/memory/entities')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('gets entity by id', async () => {
      const createRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'GetById Entity'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/memory/entities/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('GetById Entity')
    })

    it('returns 404 for missing entity', async () => {
      const res = await request(ctx, 'GET', '/api/memory/entities/99999')
      expect(res.status).toBe(404)
    })

    it('updates an entity', async () => {
      const createRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'UpdateMe Entity'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/memory/entities/${id}`, {
        name: 'Updated Entity'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('Updated Entity')
    })

    it('deletes an entity', async () => {
      const createRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'DeleteMe Entity'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/memory/entities/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('Search', () => {
    it('searches entities', async () => {
      await request(ctx, 'POST', '/api/memory/entities', {
        name: 'Searchable Entity'
      })

      const res = await request(ctx, 'GET', '/api/memory/search?q=Searchable')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('returns 400 if q missing', async () => {
      const res = await request(ctx, 'GET', '/api/memory/search')
      expect(res.status).toBe(400)
    })
  })

  describe('Stats', () => {
    it('returns memory stats', async () => {
      const res = await request(ctx, 'GET', '/api/memory/stats')
      expect(res.status).toBe(200)
      expect(res.body).toBeDefined()
    })
  })

  describe('Observations', () => {
    it('adds an observation', async () => {
      const entityRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'Obs Entity'
      })
      const entityId = (entityRes.body as any).id

      const res = await request(ctx, 'POST', `/api/memory/entities/${entityId}/observations`, {
        content: 'An important observation'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).content).toBe('An important observation')
    })

    it('returns 400 if content missing', async () => {
      const entityRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'NoObs Entity'
      })
      const entityId = (entityRes.body as any).id

      const res = await request(ctx, 'POST', `/api/memory/entities/${entityId}/observations`, {})
      expect(res.status).toBe(400)
    })

    it('lists observations', async () => {
      const entityRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'ListObs Entity'
      })
      const entityId = (entityRes.body as any).id

      await request(ctx, 'POST', `/api/memory/entities/${entityId}/observations`, {
        content: 'Obs 1'
      })

      const res = await request(ctx, 'GET', `/api/memory/entities/${entityId}/observations`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBeGreaterThanOrEqual(1)
    })

    it('deletes an observation', async () => {
      const entityRes = await request(ctx, 'POST', '/api/memory/entities', {
        name: 'DelObs Entity'
      })
      const entityId = (entityRes.body as any).id

      const obsRes = await request(ctx, 'POST', `/api/memory/entities/${entityId}/observations`, {
        content: 'Delete me'
      })
      const obsId = (obsRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/memory/observations/${obsId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('Relations', () => {
    it('adds a relation', async () => {
      const e1 = await request(ctx, 'POST', '/api/memory/entities', { name: 'Entity A' })
      const e2 = await request(ctx, 'POST', '/api/memory/entities', { name: 'Entity B' })

      const res = await request(ctx, 'POST', '/api/memory/relations', {
        fromEntityId: (e1.body as any).id,
        toEntityId: (e2.body as any).id,
        relationType: 'related_to'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).relation_type).toBe('related_to')
    })

    it('returns 400 if fromEntityId missing', async () => {
      const res = await request(ctx, 'POST', '/api/memory/relations', {
        toEntityId: 1,
        relationType: 'test'
      })
      expect(res.status).toBe(400)
    })

    it('lists relations for entity', async () => {
      const e1 = await request(ctx, 'POST', '/api/memory/entities', { name: 'RelFrom' })
      const e2 = await request(ctx, 'POST', '/api/memory/entities', { name: 'RelTo' })
      const fromId = (e1.body as any).id

      await request(ctx, 'POST', '/api/memory/relations', {
        fromEntityId: fromId,
        toEntityId: (e2.body as any).id,
        relationType: 'knows'
      })

      const res = await request(ctx, 'GET', `/api/memory/entities/${fromId}/relations`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('deletes a relation', async () => {
      const e1 = await request(ctx, 'POST', '/api/memory/entities', { name: 'DelRelFrom' })
      const e2 = await request(ctx, 'POST', '/api/memory/entities', { name: 'DelRelTo' })

      const relRes = await request(ctx, 'POST', '/api/memory/relations', {
        fromEntityId: (e1.body as any).id,
        toEntityId: (e2.body as any).id,
        relationType: 'temp'
      })
      const relId = (relRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/memory/relations/${relId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })
})
