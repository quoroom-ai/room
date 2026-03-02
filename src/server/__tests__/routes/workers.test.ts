import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Worker routes', () => {
  describe('POST /api/workers', () => {
    it('creates a worker', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        name: 'Test Worker',
        systemPrompt: 'You are a test worker.'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('Test Worker')
      expect((res.body as any).systemPrompt).toBe('You are a test worker.')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        systemPrompt: 'No name'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if systemPrompt missing', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        name: 'No Prompt'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/workers', () => {
    it('lists workers', async () => {
      const res = await request(ctx, 'GET', '/api/workers')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/workers/:id', () => {
    it('returns a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'FindMe',
        systemPrompt: 'prompt'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/workers/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('FindMe')
    })

    it('returns 404 for missing worker', async () => {
      const res = await request(ctx, 'GET', '/api/workers/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/workers/:id', () => {
    it('updates a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'UpdateMe',
        systemPrompt: 'old'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        name: 'Updated Name'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('Updated Name')
    })

    it('updates model and persists it', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'ModelWorker',
        systemPrompt: 'test'
      })
      const id = (createRes.body as any).id
      expect((createRes.body as any).model).toBeNull()

      // Set model to openai
      const patchRes = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        model: 'openai:gpt-4o-mini'
      })
      expect(patchRes.status).toBe(200)
      expect((patchRes.body as any).model).toBe('openai:gpt-4o-mini')

      // Verify it persists on re-read
      const getRes = await request(ctx, 'GET', `/api/workers/${id}`)
      expect(getRes.status).toBe(200)
      expect((getRes.body as any).model).toBe('openai:gpt-4o-mini')

      // Set model back to null (claude default)
      const resetRes = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        model: null
      })
      expect(resetRes.status).toBe(200)
      expect((resetRes.body as any).model).toBeNull()
    })
  })

  describe('DELETE /api/workers/:id', () => {
    it('deletes a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'DeleteMe',
        systemPrompt: 'prompt'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/workers/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/workers/:id/start', () => {
    it('returns 409 when room runtime is not started', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerGateRoom' })
      const queenId = (roomRes.body as any).queen.id as number

      const res = await request(ctx, 'POST', `/api/workers/${queenId}/start`)
      expect(res.status).toBe(409)
      expect((res.body as any).error).toMatch(/start the room first/i)
    })

    it('starts worker after room start', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerStartRoom' })
      const roomId = (roomRes.body as any).room.id as number
      const queenId = (roomRes.body as any).queen.id as number

      await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'openai:gpt-4o-mini' })
      const startRoom = await request(ctx, 'POST', `/api/rooms/${roomId}/start`)
      expect(startRoom.status).toBe(200)

      const res = await request(ctx, 'POST', `/api/workers/${queenId}/start`)
      expect(res.status).toBe(200)
      expect((res.body as any).running).toBe(true)

      await request(ctx, 'POST', `/api/rooms/${roomId}/stop`)
    })
  })

  describe('GET /api/rooms/:roomId/workers', () => {
    it('lists workers for a room', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerRoom' })
      const roomId = (roomRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/workers`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      // Room creation creates a queen worker
      expect((res.body as any[]).length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Worker prompt sync routes', () => {
    it('POST /api/workers/prompts/export returns summary and writes markdown files', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-export-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'exportsyncroom' })
        const roomId = (roomRes.body as any).room.id as number
        const workerRes = await request(ctx, 'POST', '/api/workers', {
          name: 'Export Target',
          systemPrompt: 'prompt export',
          roomId,
        })
        const workerId = (workerRes.body as any).id as number

        const exportRes = await request(ctx, 'POST', '/api/workers/prompts/export', {
          roomId,
          workerIds: [workerId],
        })

        expect(exportRes.status).toBe(200)
        expect((exportRes.body as any).summary.written).toBe(1)

        const filePath = (exportRes.body as any).results[0].path as string
        const content = readFileSync(filePath, 'utf-8')
        expect(content).toContain(`worker_id: ${workerId}`)
        expect(content).toContain('prompt export')
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('POST /api/workers/prompts/import updates existing workers', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-import-update-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'importupdateroom' })
        const roomId = (roomRes.body as any).room.id as number
        const createRes = await request(ctx, 'POST', '/api/workers', {
          name: 'Import Existing',
          systemPrompt: 'old prompt',
          roomId,
        })
        const workerId = (createRes.body as any).id as number

        ctx.db.prepare(`UPDATE workers SET updated_at = datetime('now','localtime','-2 hours') WHERE id = ?`).run(workerId)

        const fileDir = join(tmpRoot, '.quoroom', 'prompts', 'workers', `room-${roomId}`)
        mkdirSync(fileDir, { recursive: true })
        const filePath = join(fileDir, 'import-existing.md')
        writeFileSync(filePath, [
          '---',
          'version: 1',
          `worker_id: ${workerId}`,
          `room_id: ${roomId}`,
          'name: "Import Existing"',
          '---',
          'updated prompt from file',
          ''
        ].join('\n'))

        const importRes = await request(ctx, 'POST', '/api/workers/prompts/import', {
          paths: [filePath],
        })
        expect(importRes.status).toBe(200)
        expect((importRes.body as any).summary.updated).toBe(1)

        const getRes = await request(ctx, 'GET', `/api/workers/${workerId}`)
        expect((getRes.body as any).systemPrompt).toBe('updated prompt from file\n')
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('POST /api/workers/prompts/import creates missing workers', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-import-create-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'importcreateroom' })
        const roomId = (roomRes.body as any).room.id as number

        const fileDir = join(tmpRoot, '.quoroom', 'prompts', 'workers', `room-${roomId}`)
        mkdirSync(fileDir, { recursive: true })
        const filePath = join(fileDir, 'new-worker.md')
        writeFileSync(filePath, [
          '---',
          'version: 1',
          `room_id: ${roomId}`,
          'name: "Created from import"',
          'role: "writer"',
          '---',
          'created prompt',
          ''
        ].join('\n'))

        const importRes = await request(ctx, 'POST', '/api/workers/prompts/import', { paths: [filePath] })
        expect(importRes.status).toBe(200)
        expect((importRes.body as any).summary.created).toBe(1)

        const roomWorkers = await request(ctx, 'GET', `/api/rooms/${roomId}/workers`)
        expect((roomWorkers.body as any[]).some(w => w.name === 'Created from import')).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('conflict skipping and force override behavior on import', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-import-force-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const createRes = await request(ctx, 'POST', '/api/workers', {
          name: 'Conflict Worker',
          systemPrompt: 'db current',
        })
        const workerId = (createRes.body as any).id as number

        const fileDir = join(tmpRoot, '.quoroom', 'prompts', 'workers', 'room-global')
        mkdirSync(fileDir, { recursive: true })
        const filePath = join(fileDir, 'conflict.md')
        writeFileSync(filePath, [
          '---',
          `worker_id: ${workerId}`,
          'name: "Conflict Worker"',
          '---',
          'file value',
          ''
        ].join('\n'))

        ctx.db.prepare(`UPDATE workers SET updated_at = datetime('now','localtime') WHERE id = ?`).run(workerId)
        const past = new Date(Date.now() - 120_000)
        utimesSync(filePath, past, past)

        const skipped = await request(ctx, 'POST', '/api/workers/prompts/import', {
          paths: [filePath],
          force: false,
        })
        expect((skipped.body as any).summary.skipped).toBe(1)
        expect((skipped.body as any).results[0].reason).toBe('db_newer_than_file')

        const forced = await request(ctx, 'POST', '/api/workers/prompts/import', {
          paths: [filePath],
          force: true,
        })
        expect((forced.body as any).summary.updated).toBe(1)
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('room-scoped import/export only affects matching room', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-room-scope-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const roomARes = await request(ctx, 'POST', '/api/rooms', { name: 'scopea' })
        const roomBRes = await request(ctx, 'POST', '/api/rooms', { name: 'scopeb' })
        const roomA = (roomARes.body as any).room.id as number
        const roomB = (roomBRes.body as any).room.id as number

        const wa = await request(ctx, 'POST', '/api/workers', { name: 'Worker A', systemPrompt: 'A', roomId: roomA })
        const wb = await request(ctx, 'POST', '/api/workers', { name: 'Worker B', systemPrompt: 'B', roomId: roomB })
        const workerAId = (wa.body as any).id as number
        const workerBId = (wb.body as any).id as number

        const exported = await request(ctx, 'POST', '/api/workers/prompts/export', { roomId: roomA })
        const exportedIds = (exported.body as any).results
          .filter((r: any) => r.status === 'written')
          .map((r: any) => r.workerId)
        expect(exportedIds).toContain(workerAId)
        expect(exportedIds).not.toContain(workerBId)

        const bPath = join(tmpRoot, '.quoroom', 'prompts', 'workers', `room-${roomB}`, 'room-b.md')
        mkdirSync(join(tmpRoot, '.quoroom', 'prompts', 'workers', `room-${roomB}`), { recursive: true })
        writeFileSync(bPath, [
          '---',
          `worker_id: ${workerBId}`,
          `room_id: ${roomB}`,
          'name: "Worker B"',
          '---',
          'scope mismatch',
          ''
        ].join('\n'))

        const importRes = await request(ctx, 'POST', '/api/workers/prompts/import', {
          roomId: roomA,
          paths: [bPath],
        })
        expect((importRes.body as any).summary.errors).toBe(1)
        expect((importRes.body as any).results[0].reason).toBe('room_mismatch')
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('validates prompt sync route payloads', async () => {
      const exportBad = await request(ctx, 'POST', '/api/workers/prompts/export', { workerIds: 'not-array' })
      expect(exportBad.status).toBe(400)

      const importBad = await request(ctx, 'POST', '/api/workers/prompts/import', { paths: [123] })
      expect(importBad.status).toBe(400)

      const roomBad = await request(ctx, 'POST', '/api/workers/prompts/import', { roomId: 0 })
      expect(roomBad.status).toBe(400)
    })

    it('imports all markdown files from default prompt directory when paths omitted', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-autodiscover-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'autodiscoverroom' })
        const roomId = (roomRes.body as any).room.id as number

        const dir = join(tmpRoot, '.quoroom', 'prompts', 'workers', `room-${roomId}`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'one.md'), [
          '---',
          `room_id: ${roomId}`,
          'name: "Auto One"',
          '---',
          'prompt one',
          ''
        ].join('\n'))
        writeFileSync(join(dir, 'two.md'), [
          '---',
          `room_id: ${roomId}`,
          'name: "Auto Two"',
          '---',
          'prompt two',
          ''
        ].join('\n'))

        const importRes = await request(ctx, 'POST', '/api/workers/prompts/import', { roomId })
        expect(importRes.status).toBe(200)
        expect((importRes.body as any).summary.created).toBe(2)
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })

    it('export respects file-newer conflict and force override', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'workers-route-export-force-'))
      const prev = process.env.QUOROOM_PROMPTS_ROOT
      process.env.QUOROOM_PROMPTS_ROOT = tmpRoot

      try {
        const workerRes = await request(ctx, 'POST', '/api/workers', {
          name: 'Export Conflict Worker',
          systemPrompt: 'initial',
        })
        const workerId = (workerRes.body as any).id as number

        const firstExport = await request(ctx, 'POST', '/api/workers/prompts/export', { workerIds: [workerId] })
        const filePath = (firstExport.body as any).results[0].path as string

        const future = new Date(Date.now() + 120_000)
        utimesSync(filePath, future, future)

        const skipped = await request(ctx, 'POST', '/api/workers/prompts/export', {
          workerIds: [workerId],
          force: false,
        })
        expect((skipped.body as any).summary.skipped).toBe(1)
        expect((skipped.body as any).results[0].reason).toBe('file_newer_than_db')

        const forced = await request(ctx, 'POST', '/api/workers/prompts/export', {
          workerIds: [workerId],
          force: true,
        })
        expect((forced.body as any).summary.written).toBe(1)
      } finally {
        if (prev === undefined) delete process.env.QUOROOM_PROMPTS_ROOT
        else process.env.QUOROOM_PROMPTS_ROOT = prev
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    })
  })
})
