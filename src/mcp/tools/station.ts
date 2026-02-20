import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getRoomCloudId,
  listCloudStations,
  execOnCloudStation,
  getCloudStationLogs,
  startCloudStation,
  stopCloudStation,
  deleteCloudStation,
} from '../../shared/cloud-sync'

const CLOUD_BASE = 'https://quoroom.ai'

export function registerStationTools(server: McpServer): void {
  server.registerTool(
    'quoroom_station_create',
    {
      title: 'Create Station',
      description: 'Rent a cloud server (station) for the room via quoroom.ai. '
        + 'Returns a payment URL — open it in a browser to subscribe. '
        + 'The station appears in ~30 seconds after payment. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence, include the URL.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        name: z.string().min(1).max(100).describe('Station name (e.g., "web-server", "scraper-01")'),
        tier: z.enum(['micro', 'small', 'medium', 'large']).describe(
          'Station tier: micro ($5/mo, 1 vCPU, 256 MB), small ($15/mo, 2 vCPU, 2 GB), '
          + 'medium ($40/mo, 2 vCPU perf, 4 GB), large ($100/mo, 4 vCPU perf, 8 GB)'
        )
      }
    },
    async ({ roomId }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      const url = `${CLOUD_BASE}/stations?room=${encodeURIComponent(cloudRoomId)}`
      return {
        content: [{
          type: 'text' as const,
          text: `To add a station, complete payment at: ${url}\n\nThe station will appear in your room within ~30 seconds after payment.`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_station_list',
    {
      title: 'List Stations',
      description: 'List all stations for the room, optionally filtered by status.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        status: z.enum(['pending', 'active', 'stopped', 'canceling', 'past_due', 'error']).optional()
          .describe('Filter by status')
      }
    },
    async ({ roomId, status }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      const stations = await listCloudStations(cloudRoomId)
      const filtered = status ? stations.filter(s => s.status === status) : stations
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No stations found.' }] }
      }
      const list = filtered.map(s => ({
        id: s.id, name: s.stationName, tier: s.tier, status: s.status,
        monthlyCost: s.monthlyCost, createdAt: s.createdAt
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
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID to start')
      }
    },
    async ({ roomId, id }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      await startCloudStation(cloudRoomId, id)
      return { content: [{ type: 'text' as const, text: `Station ${id} start requested.` }] }
    }
  )

  server.registerTool(
    'quoroom_station_stop',
    {
      title: 'Stop Station',
      description: 'Stop a running station. RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID to stop')
      }
    },
    async ({ roomId, id }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      await stopCloudStation(cloudRoomId, id)
      return { content: [{ type: 'text' as const, text: `Station ${id} stop requested.` }] }
    }
  )

  server.registerTool(
    'quoroom_station_delete',
    {
      title: 'Delete Station',
      description: 'Cancel a station subscription and destroy the Fly.io machine. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID to delete')
      }
    },
    async ({ roomId, id }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      await deleteCloudStation(cloudRoomId, id)
      return {
        content: [{
          type: 'text' as const,
          text: `Station ${id} deletion requested (subscription canceled, machine destroyed).`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_station_exec',
    {
      title: 'Execute on Station',
      description: 'Execute a shell command on a station and return stdout/stderr.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID'),
        command: z.string().min(1).describe('Shell command to execute')
      }
    },
    async ({ roomId, id, command }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      const result = await execOnCloudStation(cloudRoomId, id, command)
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'Failed to execute command on station.' }],
          isError: true
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, null, 2)
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_station_logs',
    {
      title: 'Station Logs',
      description: 'Get recent logs from a station.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID'),
        lines: z.number().int().positive().max(1000).optional().describe('Number of log lines (default: all)')
      }
    },
    async ({ roomId, id, lines }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      const logs = await getCloudStationLogs(cloudRoomId, id, lines)
      if (logs === null) {
        return {
          content: [{ type: 'text' as const, text: 'Failed to retrieve logs.' }],
          isError: true
        }
      }
      return { content: [{ type: 'text' as const, text: logs || '(no logs)' }] }
    }
  )

  server.registerTool(
    'quoroom_station_status',
    {
      title: 'Station Status',
      description: 'Get live status for a station from the cloud.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID')
      }
    },
    async ({ roomId, id }) => {
      const cloudRoomId = getRoomCloudId(roomId)
      const stations = await listCloudStations(cloudRoomId)
      const station = stations.find(s => s.id === id)
      if (!station) {
        return {
          content: [{ type: 'text' as const, text: `Station ${id} not found` }],
          isError: true
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: station.id, name: station.stationName, tier: station.tier,
            status: station.status, monthlyCost: station.monthlyCost,
            currentPeriodEnd: station.currentPeriodEnd, createdAt: station.createdAt
          }, null, 2)
        }]
      }
    }
  )
}
