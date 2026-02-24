import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'
import { createToolHarness } from './helpers/tool-harness'

const { toolHandlers, mockServer, getResponseText } = createToolHarness()

let db: Database.Database
vi.mock('../../db', () => ({
  getMcpDatabase: () => db
}))

// Mock cloud-sync functions
vi.mock('../../../shared/cloud-sync', () => ({
  getRoomCloudId: (roomId: number) => `mock-cloud-id-${roomId}`,
  ensureCloudRoomToken: vi.fn().mockResolvedValue(true),
  listCloudStations: vi.fn().mockResolvedValue([
    {
      id: 1,
      roomId: 'mock-cloud-id-1',
      tier: 'small',
      stationName: 'web-server',
      flyAppName: 'qr-web-server-abc',
      flyMachineId: 'mch123',
      status: 'active',
      monthlyCost: 15,
      currentPeriodEnd: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  ]),
  execOnCloudStation: vi.fn().mockResolvedValue({ stdout: 'hello\n', stderr: '', exitCode: 0 }),
  getCloudStationLogs: vi.fn().mockResolvedValue('log line 1\nlog line 2'),
  startCloudStation: vi.fn().mockResolvedValue(undefined),
  stopCloudStation: vi.fn().mockResolvedValue(undefined),
  deleteCloudStation: vi.fn().mockResolvedValue(undefined),
  cancelCloudStation: vi.fn().mockResolvedValue(undefined),
}))

let roomId: number

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  const room = queries.createRoom(db, 'Station Test Room', 'deploy things')
  roomId = room.id

  const { registerStationTools } = await import('../station')
  registerStationTools(mockServer as never)
})

afterEach(() => {
  db.close()
  vi.clearAllMocks()
})

describe('quoroom_station_create', () => {
  it('returns checkout URL', async () => {
    const handler = toolHandlers.get('quoroom_station_create')!
    const result = await handler({ roomId, name: 'web-server', tier: 'small' })
    expect(result.isError).toBeUndefined()
    const text = getResponseText(result)
    expect(text).toContain('https://quoroom.ai/stations?room=')
    expect(text).toContain('mock-cloud-id')
  })
})

describe('quoroom_station_list', () => {
  it('returns stations from cloud', async () => {
    const handler = toolHandlers.get('quoroom_station_list')!
    const result = await handler({ roomId })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(getResponseText(result))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].name).toBe('web-server')
    expect(parsed[0].tier).toBe('small')
  })

  it('returns empty message when no stations', async () => {
    const { listCloudStations } = await import('../../../shared/cloud-sync')
    vi.mocked(listCloudStations).mockResolvedValueOnce([])
    const handler = toolHandlers.get('quoroom_station_list')!
    const result = await handler({ roomId })
    expect(getResponseText(result)).toBe('No stations found.')
  })
})

describe('quoroom_station_start', () => {
  it('requests station start', async () => {
    const handler = toolHandlers.get('quoroom_station_start')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('start requested')
  })
})

describe('quoroom_station_stop', () => {
  it('requests station stop', async () => {
    const handler = toolHandlers.get('quoroom_station_stop')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('stop requested')
  })
})

describe('quoroom_station_delete', () => {
  it('requests station deletion', async () => {
    const handler = toolHandlers.get('quoroom_station_delete')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('deletion requested')
  })
})

describe('quoroom_station_cancel', () => {
  it('requests station cancellation at end of billing period', async () => {
    const handler = toolHandlers.get('quoroom_station_cancel')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    const text = getResponseText(result)
    expect(text).toContain('cancellation requested')
    expect(text).toContain('end of billing period')
  })

  it('calls cancelCloudStation with correct cloud room ID', async () => {
    const { cancelCloudStation } = await import('../../../shared/cloud-sync')
    const handler = toolHandlers.get('quoroom_station_cancel')!
    await handler({ roomId, id: 42 })
    expect(vi.mocked(cancelCloudStation)).toHaveBeenCalledWith(`mock-cloud-id-${roomId}`, 42)
  })
})

describe('quoroom_station_exec', () => {
  it('executes command and returns result', async () => {
    const handler = toolHandlers.get('quoroom_station_exec')!
    const result = await handler({ roomId, id: 1, command: 'echo hello' })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toBe('hello\n')
  })

  it('returns error when exec fails', async () => {
    const { execOnCloudStation } = await import('../../../shared/cloud-sync')
    vi.mocked(execOnCloudStation).mockResolvedValueOnce(null)
    const handler = toolHandlers.get('quoroom_station_exec')!
    const result = await handler({ roomId, id: 1, command: 'ls' })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_station_logs', () => {
  it('returns station logs', async () => {
    const handler = toolHandlers.get('quoroom_station_logs')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('log line 1')
  })

  it('returns error when logs fail', async () => {
    const { getCloudStationLogs } = await import('../../../shared/cloud-sync')
    vi.mocked(getCloudStationLogs).mockResolvedValueOnce(null)
    const handler = toolHandlers.get('quoroom_station_logs')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_station_status', () => {
  it('returns station status', async () => {
    const handler = toolHandlers.get('quoroom_station_status')!
    const result = await handler({ roomId, id: 1 })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.status).toBe('active')
    expect(parsed.name).toBe('web-server')
  })

  it('returns error for nonexistent station', async () => {
    const handler = toolHandlers.get('quoroom_station_status')!
    const result = await handler({ roomId, id: 9999 })
    expect(result.isError).toBe(true)
  })
})

describe('tool registration', () => {
  it('registers all 9 station tools', () => {
    expect(toolHandlers.has('quoroom_station_create')).toBe(true)
    expect(toolHandlers.has('quoroom_station_list')).toBe(true)
    expect(toolHandlers.has('quoroom_station_start')).toBe(true)
    expect(toolHandlers.has('quoroom_station_stop')).toBe(true)
    expect(toolHandlers.has('quoroom_station_delete')).toBe(true)
    expect(toolHandlers.has('quoroom_station_cancel')).toBe(true)
    expect(toolHandlers.has('quoroom_station_exec')).toBe(true)
    expect(toolHandlers.has('quoroom_station_logs')).toBe(true)
    expect(toolHandlers.has('quoroom_station_status')).toBe(true)
    expect(toolHandlers.has('quoroom_station_deploy')).toBe(false)
    expect(toolHandlers.has('quoroom_station_domain')).toBe(false)
  })
})
