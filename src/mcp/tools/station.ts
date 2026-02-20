import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { provisionStation, startStation, stopStation, destroyStation, execOnStation, getStationLogs, getStationStatus } from '../../shared/station'
import type { StationProvider, StationTier } from '../../shared/types'

export function registerStationTools(server: McpServer): void {
  server.registerTool(
    'quoroom_station_create',
    {
      title: 'Create Station',
      description: 'Provision a new cloud server (station) for the room. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        name: z.string().min(1).max(100).describe('Station name (e.g., "web-server", "scraper-01")'),
        provider: z.enum(['flyio', 'e2b', 'modal', 'mock']).describe('Infrastructure provider'),
        tier: z.enum(['micro', 'small', 'medium', 'large', 'ephemeral', 'gpu']).describe('Station tier/size'),
        region: z.string().max(50).optional().describe('Region (e.g., "us-east-1")')
      }
    },
    async ({ roomId, name, provider, tier, region }) => {
      const db = getMcpDatabase()
      try {
        const station = await provisionStation(db, roomId, name, provider as StationProvider, tier as StationTier, { region })
        return {
          content: [{
            type: 'text' as const,
            text: `Station "${name}" created (id: ${station.id}, provider: ${provider}, tier: ${tier}).`
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_list',
    {
      title: 'List Stations',
      description: 'List all stations, optionally filtered by room or status.',
      inputSchema: {
        roomId: z.number().optional().describe('Filter by room ID'),
        status: z.enum(['provisioning', 'running', 'stopped', 'error', 'deleted']).optional().describe('Filter by status')
      }
    },
    async ({ roomId, status }) => {
      const db = getMcpDatabase()
      const stations = queries.listStations(db, roomId, status)
      if (stations.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No stations found.' }] }
      }
      const list = stations.map(s => ({
        id: s.id, name: s.name, provider: s.provider, tier: s.tier,
        status: s.status, region: s.region, monthlyCost: s.monthlyCost,
        roomId: s.roomId, createdAt: s.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_station_start',
    {
      title: 'Start Station',
      description: 'Start a stopped station. RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The station ID to start')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        const station = await startStation(db, id)
        return { content: [{ type: 'text' as const, text: `Station "${station.name}" started.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_stop',
    {
      title: 'Stop Station',
      description: 'Stop a running station. RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The station ID to stop')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        const station = await stopStation(db, id)
        return { content: [{ type: 'text' as const, text: `Station "${station.name}" stopped.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_delete',
    {
      title: 'Delete Station',
      description: 'Permanently destroy a station. RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The station ID to destroy')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        await destroyStation(db, id)
        return { content: [{ type: 'text' as const, text: `Station ${id} destroyed.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_exec',
    {
      title: 'Execute on Station',
      description: 'Execute a command on a station and return stdout/stderr.',
      inputSchema: {
        id: z.number().describe('The station ID'),
        command: z.string().min(1).describe('Shell command to execute')
      }
    },
    async ({ id, command }) => {
      const db = getMcpDatabase()
      try {
        const result = await execOnStation(db, id, command)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, null, 2)
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_logs',
    {
      title: 'Station Logs',
      description: 'Get recent logs from a station.',
      inputSchema: {
        id: z.number().describe('The station ID'),
        lines: z.number().int().positive().max(1000).optional().describe('Number of log lines (default: all)')
      }
    },
    async ({ id, lines }) => {
      const db = getMcpDatabase()
      try {
        const logs = await getStationLogs(db, id, lines)
        return { content: [{ type: 'text' as const, text: logs || '(no logs)' }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_status',
    {
      title: 'Station Status',
      description: 'Get live status for a station from the provider.',
      inputSchema: {
        id: z.number().describe('The station ID')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        const station = queries.getStation(db, id)
        if (!station) return { content: [{ type: 'text' as const, text: `Station ${id} not found` }], isError: true }
        const liveStatus = station.externalId ? await getStationStatus(db, id) : station.status
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: station.id, name: station.name, provider: station.provider,
              tier: station.tier, status: liveStatus, region: station.region,
              monthlyCost: station.monthlyCost, externalId: station.externalId
            }, null, 2)
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_station_deploy',
    {
      title: 'Deploy to Station',
      description: 'Deploy code or a container to a station. Currently a placeholder — provider-specific deployment coming soon. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The station ID'),
        source: z.string().min(1).describe('Source to deploy (git URL, Docker image, or path)')
      }
    },
    async ({ id, source: _source }) => {
      const db = getMcpDatabase()
      const station = queries.getStation(db, id)
      if (!station) return { content: [{ type: 'text' as const, text: `Station ${id} not found` }], isError: true }
      return {
        content: [{
          type: 'text' as const,
          text: `Deploy to station "${station.name}" is not yet implemented for provider "${station.provider}". Use station_exec to run deployment commands manually.`
        }],
        isError: true
      }
    }
  )

  server.registerTool(
    'quoroom_station_domain',
    {
      title: 'Station Domain',
      description: 'Configure a custom domain for a station. Currently a placeholder — provider-specific domain config coming soon. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The station ID'),
        domain: z.string().min(1).describe('Custom domain (e.g., "myapp.com")')
      }
    },
    async ({ id, domain: _domain }) => {
      const db = getMcpDatabase()
      const station = queries.getStation(db, id)
      if (!station) return { content: [{ type: 'text' as const, text: `Station ${id} not found` }], isError: true }
      return {
        content: [{
          type: 'text' as const,
          text: `Custom domain configuration for station "${station.name}" is not yet implemented for provider "${station.provider}".`
        }],
        isError: true
      }
    }
  )
}
