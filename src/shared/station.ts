/**
 * Station module.
 *
 * Stations are rented exclusively through quoroom.ai — cloud handles Stripe billing
 * and Fly.io provisioning. This file keeps only MockProvider for use in unit tests.
 */

import type { StationStatus, StationTier } from './types'

// ─── Interfaces ──────────────────────────────────────────────

export interface CreateStationOpts {
  name: string
  tier: StationTier
  region?: string
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

// ─── Mock Provider (for tests only) ──────────────────────────

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
