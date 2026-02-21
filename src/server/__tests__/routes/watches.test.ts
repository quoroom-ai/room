import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Watch routes', () => {
  const makeTempWatchPath = (name: string): string => join(tmpdir(), name)
  const unsafeWatchPath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc'

  describe('POST /api/watches', () => {
    it('creates a watch', async () => {
      const watchPath = makeTempWatchPath('test-watch')
      const res = await request(ctx, 'POST', '/api/watches', {
        path: watchPath,
        description: 'Test watch',
        actionPrompt: 'Process new files'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).path).toBe(watchPath)
    })

    it('returns 400 if path missing', async () => {
      const res = await request(ctx, 'POST', '/api/watches', {})
      expect(res.status).toBe(400)
    })

    it('returns 400 for unsafe path', async () => {
      const res = await request(ctx, 'POST', '/api/watches', {
        path: unsafeWatchPath
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/watches', () => {
    it('lists watches', async () => {
      const res = await request(ctx, 'GET', '/api/watches')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/watches/:id', () => {
    it('returns a watch', async () => {
      const watchPath = makeTempWatchPath('findme-watch')
      const createRes = await request(ctx, 'POST', '/api/watches', {
        path: watchPath
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/watches/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).path).toBe(watchPath)
    })

    it('returns 404 for missing watch', async () => {
      const res = await request(ctx, 'GET', '/api/watches/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/watches/:id/pause', () => {
    it('pauses a watch', async () => {
      const createRes = await request(ctx, 'POST', '/api/watches', {
        path: makeTempWatchPath('pause-watch')
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/watches/${id}/pause`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/watches/:id/resume', () => {
    it('resumes a watch', async () => {
      const createRes = await request(ctx, 'POST', '/api/watches', {
        path: makeTempWatchPath('resume-watch')
      })
      const id = (createRes.body as any).id

      await request(ctx, 'POST', `/api/watches/${id}/pause`)
      const res = await request(ctx, 'POST', `/api/watches/${id}/resume`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('DELETE /api/watches/:id', () => {
    it('deletes a watch', async () => {
      const createRes = await request(ctx, 'POST', '/api/watches', {
        path: makeTempWatchPath('delete-watch')
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/watches/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })
})
