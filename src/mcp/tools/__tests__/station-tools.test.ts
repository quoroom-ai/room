import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTestDb } from '../../../shared/__tests__/helpers/test-db'
import * as queries from '../../../shared/db-queries'
import { MockProvider, registerProvider } from '../../../shared/station'

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
  isError?: boolean
}>

const toolHandlers = new Map<string, ToolHandler>()

const mockServer = {
  registerTool: (_name: string, _opts: unknown, handler: ToolHandler) => {
    toolHandlers.set(_name, handler)
  }
}

let db: Database.Database
vi.mock('../../db', () => ({
  getMcpDatabase: () => db
}))

let roomId: number

beforeEach(async () => {
  toolHandlers.clear()
  db = initTestDb()

  // Fresh mock provider
  registerProvider('mock', new MockProvider())

  const room = queries.createRoom(db, 'Station Test Room', 'deploy things')
  roomId = room.id

  const { registerStationTools } = await import('../station')
  registerStationTools(mockServer as never)
})

afterEach(() => {
  db.close()
})

function getResponseText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text
}

describe('quoroom_station_create', () => {
  it('creates a station', async () => {
    const handler = toolHandlers.get('quoroom_station_create')!
    const result = await handler({ roomId, name: 'web-server', provider: 'mock', tier: 'small' })
    expect(result.isError).toBeUndefined()
    const text = getResponseText(result)
    expect(text).toContain('web-server')
    expect(text).toContain('created')
  })

  it('returns error for nonexistent room', async () => {
    const handler = toolHandlers.get('quoroom_station_create')!
    const result = await handler({ roomId: 9999, name: 'test', provider: 'mock', tier: 'micro' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('not found')
  })
})

describe('quoroom_station_list', () => {
  it('returns empty when no stations', async () => {
    const handler = toolHandlers.get('quoroom_station_list')!
    const result = await handler({})
    expect(getResponseText(result)).toBe('No stations found.')
  })

  it('lists created stations', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'web', provider: 'mock', tier: 'small' })

    const handler = toolHandlers.get('quoroom_station_list')!
    const result = await handler({})
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.length).toBe(1)
    expect(parsed[0].name).toBe('web')
  })
})

describe('quoroom_station_start', () => {
  it('starts a stopped station', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)
    const stationId = stations[0].id

    // Stop it first
    const stopHandler = toolHandlers.get('quoroom_station_stop')!
    await stopHandler({ id: stationId })

    const handler = toolHandlers.get('quoroom_station_start')!
    const result = await handler({ id: stationId })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('started')
  })
})

describe('quoroom_station_stop', () => {
  it('stops a running station', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_stop')!
    const result = await handler({ id: stations[0].id })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('stopped')
  })
})

describe('quoroom_station_delete', () => {
  it('destroys a station', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_delete')!
    const result = await handler({ id: stations[0].id })
    expect(result.isError).toBeUndefined()
    expect(getResponseText(result)).toContain('destroyed')
  })
})

describe('quoroom_station_exec', () => {
  it('executes a command', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_exec')!
    const result = await handler({ id: stations[0].id, command: 'ls -la' })
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toContain('ls -la')
  })
})

describe('quoroom_station_logs', () => {
  it('returns station logs', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_logs')!
    const result = await handler({ id: stations[0].id })
    expect(getResponseText(result)).toContain('created')
  })
})

describe('quoroom_station_status', () => {
  it('returns station status', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_status')!
    const result = await handler({ id: stations[0].id })
    const parsed = JSON.parse(getResponseText(result))
    expect(parsed.status).toBe('running')
    expect(parsed.name).toBe('test')
  })

  it('returns error for nonexistent station', async () => {
    const handler = toolHandlers.get('quoroom_station_status')!
    const result = await handler({ id: 9999 })
    expect(result.isError).toBe(true)
  })
})

describe('quoroom_station_deploy (stub)', () => {
  it('returns not-implemented message', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_deploy')!
    const result = await handler({ id: stations[0].id, source: 'https://github.com/example/app' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('not yet implemented')
  })
})

describe('quoroom_station_domain (stub)', () => {
  it('returns not-implemented message', async () => {
    const createHandler = toolHandlers.get('quoroom_station_create')!
    await createHandler({ roomId, name: 'test', provider: 'mock', tier: 'micro' })
    const stations = queries.listStations(db, roomId)

    const handler = toolHandlers.get('quoroom_station_domain')!
    const result = await handler({ id: stations[0].id, domain: 'myapp.com' })
    expect(result.isError).toBe(true)
    expect(getResponseText(result)).toContain('not yet implemented')
  })
})

describe('tool registration', () => {
  it('registers all 10 station tools', () => {
    expect(toolHandlers.has('quoroom_station_create')).toBe(true)
    expect(toolHandlers.has('quoroom_station_list')).toBe(true)
    expect(toolHandlers.has('quoroom_station_start')).toBe(true)
    expect(toolHandlers.has('quoroom_station_stop')).toBe(true)
    expect(toolHandlers.has('quoroom_station_delete')).toBe(true)
    expect(toolHandlers.has('quoroom_station_exec')).toBe(true)
    expect(toolHandlers.has('quoroom_station_logs')).toBe(true)
    expect(toolHandlers.has('quoroom_station_status')).toBe(true)
    expect(toolHandlers.has('quoroom_station_deploy')).toBe(true)
    expect(toolHandlers.has('quoroom_station_domain')).toBe(true)
  })
})
