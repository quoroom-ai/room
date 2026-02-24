import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Settings routes', () => {
  describe('PUT /api/settings/:key', () => {
    it('sets a setting', async () => {
      const res = await request(ctx, 'PUT', '/api/settings/theme', {
        value: 'dark'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).key).toBe('theme')
      expect((res.body as any).value).toBe('dark')
    })

    it('returns 400 if value missing', async () => {
      const res = await request(ctx, 'PUT', '/api/settings/broken', {})
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/settings/:key', () => {
    it('gets a setting', async () => {
      await request(ctx, 'PUT', '/api/settings/lang', { value: 'en' })

      const res = await request(ctx, 'GET', '/api/settings/lang')
      expect(res.status).toBe(200)
      expect((res.body as any).key).toBe('lang')
      expect((res.body as any).value).toBe('en')
    })

    it('returns null for missing key', async () => {
      const res = await request(ctx, 'GET', '/api/settings/nonexistent')
      expect(res.status).toBe(200)
      expect((res.body as any).value).toBeNull()
    })
  })

  describe('GET /api/settings', () => {
    it('lists all settings as key-value object', async () => {
      await request(ctx, 'PUT', '/api/settings/a', { value: '1' })
      await request(ctx, 'PUT', '/api/settings/b', { value: '2' })

      const res = await request(ctx, 'GET', '/api/settings')
      expect(res.status).toBe(200)
      expect(typeof res.body).toBe('object')
      expect((res.body as any).a).toBe('1')
      expect((res.body as any).b).toBe('2')
    })
  })
})
