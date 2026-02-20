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

// ─── Fly.io Provider ─────────────────────────────────────────

const FLY_API_BASE = 'https://api.machines.dev/v1'

const TIER_TO_FLY_GUEST: Record<string, { cpu_kind: string; cpus: number; memory_mb: number }> = {
  micro:     { cpu_kind: 'shared',      cpus: 1, memory_mb: 256 },
  small:     { cpu_kind: 'shared',      cpus: 2, memory_mb: 2048 },
  medium:    { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 },
  large:     { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
  ephemeral: { cpu_kind: 'shared',      cpus: 1, memory_mb: 256 },
  gpu:       { cpu_kind: 'performance', cpus: 8, memory_mb: 32768 },
}

function flyStateToStatus(state: string | undefined): StationStatus {
  switch (state) {
    case 'created':
    case 'starting':   return 'provisioning'
    case 'started':    return 'running'
    case 'stopping':   return 'running'
    case 'stopped':    return 'stopped'
    case 'destroying':
    case 'destroyed':  return 'deleted'
    default:           return 'error'
  }
}

class FlyioProvider implements StationProviderInterface {
  private getToken(): string {
    const token = process.env.FLY_API_TOKEN
    if (!token) throw new Error('Fly.io provider not configured. Set FLY_API_TOKEN environment variable.')
    return token
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${FLY_API_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Fly.io API error ${response.status} ${method} ${path}: ${text.slice(0, 200)}`)
    }
    if (response.status === 204) return null
    return response.json()
  }

  private parseId(externalId: string): { appName: string; machineId: string } {
    const sep = externalId.indexOf(':')
    if (sep < 0) throw new Error(`Invalid Fly.io external ID: ${externalId}`)
    return { appName: externalId.slice(0, sep), machineId: externalId.slice(sep + 1) }
  }

  async create(opts: CreateStationOpts): Promise<{ externalId: string; status: string }> {
    const slug = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 28)
    const appName = `qr-${slug}-${Date.now().toString(36)}`
    const orgSlug = process.env.FLY_ORG_SLUG ?? 'personal'

    await this.request('POST', '/apps', { app_name: appName, org_slug: orgSlug })

    const guest = TIER_TO_FLY_GUEST[opts.tier] ?? TIER_TO_FLY_GUEST.micro
    const machineConfig: Record<string, unknown> = {
      image: (opts.config?.image as string | undefined) ?? 'ubuntu:22.04',
      guest,
      ...(opts.tier === 'ephemeral' ? { auto_destroy: true } : {}),
    }

    const machine = await this.request('POST', `/apps/${appName}/machines`, {
      name: opts.name,
      region: opts.region,
      config: machineConfig,
    }) as { id: string; state?: string }

    return {
      externalId: `${appName}:${machine.id}`,
      status: flyStateToStatus(machine.state),
    }
  }

  async start(externalId: string): Promise<void> {
    const { appName, machineId } = this.parseId(externalId)
    await this.request('POST', `/apps/${appName}/machines/${machineId}/start`)
  }

  async stop(externalId: string): Promise<void> {
    const { appName, machineId } = this.parseId(externalId)
    await this.request('POST', `/apps/${appName}/machines/${machineId}/stop`)
  }

  async destroy(externalId: string): Promise<void> {
    const { appName, machineId } = this.parseId(externalId)
    try { await this.request('POST', `/apps/${appName}/machines/${machineId}/stop`) } catch { /* already stopped */ }
    await this.request('DELETE', `/apps/${appName}/machines/${machineId}`)
    try { await this.request('DELETE', `/apps/${appName}`) } catch { /* best-effort app cleanup */ }
  }

  async exec(externalId: string, command: string): Promise<ExecResult> {
    const { appName, machineId } = this.parseId(externalId)
    const result = await this.request('POST', `/apps/${appName}/machines/${machineId}/exec`, {
      cmd: ['/bin/sh', '-c', command],
      timeout: 60,
    }) as { stdout?: string; stderr?: string; exit_code?: number }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exit_code ?? 0,
    }
  }

  async getStatus(externalId: string): Promise<StationStatus> {
    const { appName, machineId } = this.parseId(externalId)
    try {
      const machine = await this.request('GET', `/apps/${appName}/machines/${machineId}`) as { state?: string }
      return flyStateToStatus(machine.state)
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return 'deleted'
      throw err
    }
  }

  async getLogs(externalId: string, lines?: number): Promise<string> {
    const { appName, machineId } = this.parseId(externalId)
    const query = lines ? `?limit=${lines}` : ''
    const result = await this.request('GET', `/apps/${appName}/machines/${machineId}/logs${query}`) as
      Array<{ message: string }> | { logs?: Array<{ message: string }> }
    const entries = Array.isArray(result) ? result : (result.logs ?? [])
    return entries.map(l => l.message).join('\n')
  }
}

// Register default providers
registerProvider('mock', new MockProvider())
registerProvider('flyio', new FlyioProvider())
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
