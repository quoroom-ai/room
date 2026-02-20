/**
 * Station Engine
 *
 * Cloud server provisioning with provider abstraction.
 * Inspired by Automaton's Conway client pattern — abstracted for Fly.io, E2B, Modal.
 */

import type Database from 'better-sqlite3'
import type { Station, StationProvider, StationTier, StationStatus } from './types'
import * as queries from './db-queries'

// ─── Provider Interface ─────────────────────────────────────

export interface CreateStationOpts {
  name: string
  tier: StationTier
  region?: string
  config?: Record<string, unknown>
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface StationProviderInterface {
  create(opts: CreateStationOpts): Promise<{ externalId: string; status: string }>
  start(externalId: string): Promise<void>
  stop(externalId: string): Promise<void>
  destroy(externalId: string): Promise<void>
  exec(externalId: string, command: string): Promise<ExecResult>
  getStatus(externalId: string): Promise<StationStatus>
  getLogs(externalId: string, lines?: number): Promise<string>
}

// ─── Provider Registry ──────────────────────────────────────

const providers = new Map<string, StationProviderInterface>()

export function registerProvider(name: string, provider: StationProviderInterface): void {
  providers.set(name, provider)
}

export function getProvider(name: string): StationProviderInterface {
  const provider = providers.get(name)
  if (!provider) throw new Error(`Station provider "${name}" not registered. Available: ${[...providers.keys()].join(', ') || 'none'}`)
  return provider
}

// ─── Mock Provider (for tests) ──────────────────────────────

const mockStations = new Map<string, { status: StationStatus; logs: string[] }>()

export class MockProvider implements StationProviderInterface {
  private counter = 0

  async create(opts: CreateStationOpts): Promise<{ externalId: string; status: string }> {
    this.counter++
    const externalId = `mock-${opts.name}-${this.counter}`
    mockStations.set(externalId, { status: 'running', logs: [`Station ${externalId} created`] })
    return { externalId, status: 'running' }
  }

  async start(externalId: string): Promise<void> {
    const station = mockStations.get(externalId)
    if (!station) throw new Error(`Mock station ${externalId} not found`)
    station.status = 'running'
    station.logs.push(`Station ${externalId} started`)
  }

  async stop(externalId: string): Promise<void> {
    const station = mockStations.get(externalId)
    if (!station) throw new Error(`Mock station ${externalId} not found`)
    station.status = 'stopped'
    station.logs.push(`Station ${externalId} stopped`)
  }

  async destroy(externalId: string): Promise<void> {
    if (!mockStations.has(externalId)) throw new Error(`Mock station ${externalId} not found`)
    mockStations.delete(externalId)
  }

  async exec(externalId: string, command: string): Promise<ExecResult> {
    const station = mockStations.get(externalId)
    if (!station) throw new Error(`Mock station ${externalId} not found`)
    if (station.status !== 'running') throw new Error(`Station ${externalId} is not running (status: ${station.status})`)
    station.logs.push(`exec: ${command}`)
    return { stdout: `mock output for: ${command}`, stderr: '', exitCode: 0 }
  }

  async getStatus(externalId: string): Promise<StationStatus> {
    const station = mockStations.get(externalId)
    if (!station) return 'deleted' as StationStatus
    return station.status
  }

  async getLogs(externalId: string, lines?: number): Promise<string> {
    const station = mockStations.get(externalId)
    if (!station) throw new Error(`Mock station ${externalId} not found`)
    const logLines = lines ? station.logs.slice(-lines) : station.logs
    return logLines.join('\n')
  }

  /** Reset mock state (for tests) */
  reset(): void {
    this.counter = 0
    mockStations.clear()
  }
}

// ─── Stub Providers (not configured) ────────────────────────

class StubProvider implements StationProviderInterface {
  constructor(private name: string) {}

  private fail(): never {
    throw new Error(`${this.name} provider not configured. Set API key in room credentials.`)
  }

  async create(): Promise<never> { this.fail() }
  async start(): Promise<never> { this.fail() }
  async stop(): Promise<never> { this.fail() }
  async destroy(): Promise<never> { this.fail() }
  async exec(): Promise<never> { this.fail() }
  async getStatus(): Promise<never> { this.fail() }
  async getLogs(): Promise<never> { this.fail() }
}

// Register default providers
registerProvider('mock', new MockProvider())
registerProvider('flyio', new StubProvider('Fly.io'))
registerProvider('e2b', new StubProvider('E2B'))
registerProvider('modal', new StubProvider('Modal'))

// ─── Station Engine Functions ───────────────────────────────

/** Tier → estimated monthly cost mapping */
const TIER_COSTS: Record<string, number> = {
  micro: 5,
  small: 15,
  medium: 40,
  large: 100,
  ephemeral: 0,
  gpu: 0
}

/**
 * Provision a new station for a room.
 */
export async function provisionStation(
  db: Database.Database,
  roomId: number,
  name: string,
  providerName: StationProvider,
  tier: StationTier,
  opts?: { region?: string; config?: Record<string, unknown> }
): Promise<Station> {
  // Validate room exists
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  const provider = getProvider(providerName)

  // Create via provider
  const result = await provider.create({ name, tier, region: opts?.region, config: opts?.config })

  // Store in DB
  const station = queries.createStation(db, roomId, name, providerName, tier, {
    externalId: result.externalId,
    region: opts?.region,
    monthlyCost: TIER_COSTS[tier] ?? 0,
    config: opts?.config,
    status: result.status
  })

  // Log room activity
  queries.logRoomActivity(db, roomId, 'deployment',
    `Station "${name}" provisioned (${providerName}, ${tier})`,
    JSON.stringify({ stationId: station.id, provider: providerName, tier, externalId: result.externalId }))

  return station
}

/**
 * Start a stopped station.
 */
export async function startStation(db: Database.Database, stationId: number): Promise<Station> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)
  if (!station.externalId) throw new Error(`Station ${stationId} has no external ID`)

  const provider = getProvider(station.provider)
  await provider.start(station.externalId)
  return queries.updateStation(db, stationId, { status: 'running' })
}

/**
 * Stop a running station.
 */
export async function stopStation(db: Database.Database, stationId: number): Promise<Station> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)
  if (!station.externalId) throw new Error(`Station ${stationId} has no external ID`)

  const provider = getProvider(station.provider)
  await provider.stop(station.externalId)
  return queries.updateStation(db, stationId, { status: 'stopped' })
}

/**
 * Destroy a station permanently.
 */
export async function destroyStation(db: Database.Database, stationId: number): Promise<void> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)

  if (station.externalId) {
    const provider = getProvider(station.provider)
    await provider.destroy(station.externalId)
  }

  // Log before delete
  queries.logRoomActivity(db, station.roomId, 'deployment',
    `Station "${station.name}" destroyed`,
    JSON.stringify({ stationId, provider: station.provider }))

  queries.deleteStation(db, stationId)
}

/**
 * Execute a command on a station.
 */
export async function execOnStation(db: Database.Database, stationId: number, command: string): Promise<ExecResult> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)
  if (!station.externalId) throw new Error(`Station ${stationId} has no external ID`)

  const provider = getProvider(station.provider)
  return provider.exec(station.externalId, command)
}

/**
 * Get logs from a station.
 */
export async function getStationLogs(db: Database.Database, stationId: number, lines?: number): Promise<string> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)
  if (!station.externalId) throw new Error(`Station ${stationId} has no external ID`)

  const provider = getProvider(station.provider)
  return provider.getLogs(station.externalId, lines)
}

/**
 * Get live status from the provider.
 */
export async function getStationStatus(db: Database.Database, stationId: number): Promise<StationStatus> {
  const station = queries.getStation(db, stationId)
  if (!station) throw new Error(`Station ${stationId} not found`)
  if (!station.externalId) throw new Error(`Station ${stationId} has no external ID`)

  const provider = getProvider(station.provider)
  const status = await provider.getStatus(station.externalId)

  // Sync status to DB if changed
  if (status !== station.status) {
    queries.updateStation(db, stationId, { status })
  }

  return status
}
