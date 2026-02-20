import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import {
  MockProvider,
  registerProvider,
  provisionStation,
  startStation,
  stopStation,
  destroyStation,
  execOnStation,
  getStationLogs,
  getStationStatus
} from '../station'

let db: Database.Database
let roomId: number
let mockProvider: MockProvider

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Station Test Room', 'test goal')
  roomId = room.id

  // Fresh mock provider for each test
  mockProvider = new MockProvider()
  registerProvider('mock', mockProvider)
})

// ─── MockProvider ───────────────────────────────────────────

describe('MockProvider', () => {
  it('creates a station with unique external ID', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    expect(result.externalId).toContain('mock-test-')
    expect(result.status).toBe('running')
  })

  it('starts a stopped station', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.stop(result.externalId)
    await mockProvider.start(result.externalId)
    const status = await mockProvider.getStatus(result.externalId)
    expect(status).toBe('running')
  })

  it('stops a running station', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.stop(result.externalId)
    const status = await mockProvider.getStatus(result.externalId)
    expect(status).toBe('stopped')
  })

  it('destroys a station', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.destroy(result.externalId)
    const status = await mockProvider.getStatus(result.externalId)
    expect(status).toBe('deleted')
  })

  it('executes commands on running station', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    const exec = await mockProvider.exec(result.externalId, 'ls -la')
    expect(exec.stdout).toContain('ls -la')
    expect(exec.exitCode).toBe(0)
  })

  it('refuses to exec on stopped station', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.stop(result.externalId)
    await expect(mockProvider.exec(result.externalId, 'ls')).rejects.toThrow('not running')
  })

  it('returns logs', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.exec(result.externalId, 'hello')
    const logs = await mockProvider.getLogs(result.externalId)
    expect(logs).toContain('created')
    expect(logs).toContain('exec: hello')
  })

  it('limits log lines', async () => {
    const result = await mockProvider.create({ name: 'test', tier: 'micro' as any })
    await mockProvider.exec(result.externalId, 'cmd1')
    await mockProvider.exec(result.externalId, 'cmd2')
    const logs = await mockProvider.getLogs(result.externalId, 1)
    expect(logs.split('\n').length).toBe(1)
  })

  it('throws for nonexistent station', async () => {
    await expect(mockProvider.start('nonexistent')).rejects.toThrow('not found')
  })
})

// ─── Station Engine ─────────────────────────────────────────

describe('provisionStation', () => {
  it('provisions a station with mock provider', async () => {
    const station = await provisionStation(db, roomId, 'web-server', 'mock', 'small')
    expect(station.name).toBe('web-server')
    expect(station.provider).toBe('mock')
    expect(station.tier).toBe('small')
    expect(station.status).toBe('running')
    expect(station.externalId).toContain('mock-web-server-')
    expect(station.monthlyCost).toBe(15) // small tier cost
  })

  it('throws for nonexistent room', async () => {
    await expect(provisionStation(db, 9999, 'test', 'mock', 'micro')).rejects.toThrow('Room 9999 not found')
  })

  it('logs deployment activity', async () => {
    await provisionStation(db, roomId, 'web-server', 'mock', 'small')
    const activity = queries.getRoomActivity(db, roomId)
    const event = activity.find(a => a.eventType === 'deployment' && a.summary.includes('provisioned'))
    expect(event).toBeTruthy()
  })

  it('stores region and config', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'medium', {
      region: 'us-west-2',
      config: { ports: [80, 443] }
    })
    expect(station.region).toBe('us-west-2')
  })
})

describe('startStation', () => {
  it('starts a stopped station', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    await stopStation(db, station.id)
    const started = await startStation(db, station.id)
    expect(started.status).toBe('running')
  })

  it('throws for nonexistent station', async () => {
    await expect(startStation(db, 9999)).rejects.toThrow('Station 9999 not found')
  })
})

describe('stopStation', () => {
  it('stops a running station', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    const stopped = await stopStation(db, station.id)
    expect(stopped.status).toBe('stopped')
  })
})

describe('destroyStation', () => {
  it('destroys a station and removes from DB', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    await destroyStation(db, station.id)
    expect(queries.getStation(db, station.id)).toBeNull()
  })

  it('logs destruction activity', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    await destroyStation(db, station.id)
    const activity = queries.getRoomActivity(db, roomId)
    const event = activity.find(a => a.summary.includes('destroyed'))
    expect(event).toBeTruthy()
  })

  it('throws for nonexistent station', async () => {
    await expect(destroyStation(db, 9999)).rejects.toThrow('Station 9999 not found')
  })
})

describe('execOnStation', () => {
  it('executes a command and returns result', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    const result = await execOnStation(db, station.id, 'echo hello')
    expect(result.stdout).toContain('echo hello')
    expect(result.exitCode).toBe(0)
  })

  it('throws for nonexistent station', async () => {
    await expect(execOnStation(db, 9999, 'ls')).rejects.toThrow('Station 9999 not found')
  })
})

describe('getStationLogs', () => {
  it('returns logs from the provider', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    const logs = await getStationLogs(db, station.id)
    expect(logs).toContain('created')
  })
})

describe('getStationStatus', () => {
  it('returns live status and syncs to DB', async () => {
    const station = await provisionStation(db, roomId, 'test', 'mock', 'micro')
    const status = await getStationStatus(db, station.id)
    expect(status).toBe('running')
  })

  it('throws for nonexistent station', async () => {
    await expect(getStationStatus(db, 9999)).rejects.toThrow('Station 9999 not found')
  })
})
