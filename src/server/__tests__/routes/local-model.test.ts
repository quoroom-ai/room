import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestContext } from '../helpers/test-server'
import * as queries from '../../../shared/db-queries'
import { OLLAMA_MODEL_ID, OLLAMA_MODEL_TAG } from '../../../shared/local-model'

const {
  mockGetLocalModelStatus,
  mockStartLocalModelInstallSession,
  mockGetLatestLocalModelInstallSession,
  mockCancelLocalModelInstallSession,
} = vi.hoisted(() => ({
  mockGetLocalModelStatus: vi.fn(),
  mockStartLocalModelInstallSession: vi.fn(),
  mockGetLatestLocalModelInstallSession: vi.fn(),
  mockCancelLocalModelInstallSession: vi.fn(),
}))

vi.mock('../../local-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../local-model')>()
  return {
    ...actual,
    getLocalModelStatus: mockGetLocalModelStatus,
    startLocalModelInstallSession: mockStartLocalModelInstallSession,
    getLatestLocalModelInstallSession: mockGetLatestLocalModelInstallSession,
    cancelLocalModelInstallSession: mockCancelLocalModelInstallSession,
  }
})

let ctx: TestContext
let request: (ctx: TestContext, method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
let createTestServer: () => Promise<TestContext>

function makeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deploymentMode: 'local',
    modelId: OLLAMA_MODEL_ID,
    modelTag: OLLAMA_MODEL_TAG,
    supported: true,
    ready: false,
    blockers: [],
    warnings: [],
    requirements: {
      minRamGb: 48,
      minFreeDiskGb: 30,
      minCpuCores: 8,
      maxMemUsedPct: 80,
      maxCpuLoadRatio: 0.85,
      minDarwinMajor: 23,
      minWindowsBuild: 19045,
    },
    system: {
      platform: 'darwin',
      osRelease: '23.0.0',
      cpuCount: 10,
      loadAvg1m: 0.5,
      loadRatio: 0.05,
      memTotalGb: 64,
      memFreeGb: 40,
      memUsedPct: 38,
      diskFreeGb: 200,
    },
    runtime: {
      installed: true,
      version: '0.4.0',
      daemonReachable: true,
      modelAvailable: true,
      ready: false,
      error: null,
    },
    ...overrides,
  }
}

beforeAll(async () => {
  const helpers = await import('../helpers/test-server')
  request = helpers.request
  createTestServer = helpers.createTestServer
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

beforeEach(() => {
  mockGetLocalModelStatus.mockReset()
  mockStartLocalModelInstallSession.mockReset()
  mockGetLatestLocalModelInstallSession.mockReset()
  mockCancelLocalModelInstallSession.mockReset()

  mockGetLocalModelStatus.mockReturnValue(makeStatus())
  mockGetLatestLocalModelInstallSession.mockReturnValue(null)
  mockCancelLocalModelInstallSession.mockReturnValue(null)
})

describe('Local model routes', () => {
  it('GET /api/local-model/status returns blockers and diagnostics', async () => {
    mockGetLocalModelStatus.mockReturnValue(makeStatus({
      blockers: ['At least 48GB RAM required (detected 16GB).'],
      supported: false,
      ready: false,
    }))

    const res = await request(ctx, 'GET', '/api/local-model/status')
    expect(res.status).toBe(200)
    expect((res.body as any).modelId).toBe(OLLAMA_MODEL_ID)
    expect((res.body as any).supported).toBe(false)
    expect((res.body as any).blockers).toContain('At least 48GB RAM required (detected 16GB).')
  })

  it('POST /api/local-model/install rejects when compatibility blockers exist', async () => {
    mockGetLocalModelStatus.mockReturnValue(makeStatus({
      blockers: ['Current RAM load too high (90% used). Must be <= 80%.'],
      supported: false,
      ready: false,
    }))

    const res = await request(ctx, 'POST', '/api/local-model/install')
    expect(res.status).toBe(400)
    expect(String((res.body as any).error || '')).toContain('Local model install blocked')
    expect(mockStartLocalModelInstallSession).not.toHaveBeenCalled()
  })

  it('POST /api/local-model/install-sessions/:sessionId/cancel returns canceled session', async () => {
    mockCancelLocalModelInstallSession.mockReturnValue({
      sessionId: 'sess-1',
      status: 'canceled',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      active: false,
      exitCode: null,
      lines: [],
    })

    const res = await request(ctx, 'POST', '/api/local-model/install-sessions/sess-1/cancel')
    expect(res.status).toBe(200)
    expect((res.body as any).ok).toBe(true)
    expect((res.body as any).session.status).toBe('canceled')
  })

  it('POST /api/local-model/apply-all updates clerk/global defaults and active room queen models', async () => {
    mockGetLocalModelStatus.mockReturnValue(makeStatus({
      ready: true,
      runtime: {
        installed: true,
        version: '0.4.0',
        daemonReachable: true,
        modelAvailable: true,
        ready: true,
        error: null,
      },
    }))

    queries.setSetting(ctx.db, 'clerk_model', 'claude')
    queries.setSetting(ctx.db, 'queen_model', 'claude')

    const activeRoomRes = await request(ctx, 'POST', '/api/rooms', { name: 'localapplyactive' })
    const activeRoomId = (activeRoomRes.body as any).room.id as number
    const activeQueenId = (activeRoomRes.body as any).queen.id as number
    await request(ctx, 'PATCH', `/api/workers/${activeQueenId}`, { model: 'codex' })
    await request(ctx, 'PATCH', `/api/rooms/${activeRoomId}`, { workerModel: 'openai:gpt-4o-mini' })

    const pausedRoomRes = await request(ctx, 'POST', '/api/rooms', { name: 'localapplypaused' })
    const pausedRoomId = (pausedRoomRes.body as any).room.id as number
    const pausedQueenId = (pausedRoomRes.body as any).queen.id as number
    await request(ctx, 'PATCH', `/api/workers/${pausedQueenId}`, { model: 'codex' })
    await request(ctx, 'PATCH', `/api/rooms/${pausedRoomId}`, { workerModel: 'openai:gpt-4o-mini' })
    await request(ctx, 'POST', `/api/rooms/${pausedRoomId}/pause`)

    const res = await request(ctx, 'POST', '/api/local-model/apply-all')
    expect(res.status).toBe(200)
    expect((res.body as any).modelId).toBe(OLLAMA_MODEL_ID)
    expect((res.body as any).rooms.some((entry: any) => entry.roomId === activeRoomId)).toBe(true)
    expect((res.body as any).rooms.some((entry: any) => entry.roomId === pausedRoomId)).toBe(false)

    expect(queries.getSetting(ctx.db, 'clerk_model')).toBe(OLLAMA_MODEL_ID)
    expect(queries.getSetting(ctx.db, 'queen_model')).toBe(OLLAMA_MODEL_ID)

    const activeQueen = queries.getWorker(ctx.db, activeQueenId)!
    const pausedQueen = queries.getWorker(ctx.db, pausedQueenId)!
    expect(activeQueen.model).toBe(OLLAMA_MODEL_ID)
    expect(pausedQueen.model).toBe('codex')

    const activeRoom = queries.getRoom(ctx.db, activeRoomId)!
    const pausedRoom = queries.getRoom(ctx.db, pausedRoomId)!
    expect(activeRoom.workerModel).toBe('queen')
    expect(pausedRoom.workerModel).toBe('openai:gpt-4o-mini')
  })
})
