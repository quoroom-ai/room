import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import {
  getRoomCloudId,
  ensureCloudRoomToken,
  listCloudStations,
  execOnCloudStation,
  getCloudStationLogs,
  startCloudStation,
  stopCloudStation,
  deleteCloudStation,
  cancelCloudStation,
  getCloudCryptoPrices,
  cryptoCheckoutStation,
  cryptoRenewStation,
} from '../../shared/cloud-sync'
import { sendUSDC } from '../../shared/wallet'

const CLOUD_BASE = 'https://quoroom.ai'

async function bootstrapRoomToken(roomId: number): Promise<void> {
  const db = getMcpDatabase()
  const room = queries.getRoom(db, roomId)
  if (!room) return
  await ensureCloudRoomToken({
    roomId: getRoomCloudId(roomId),
    name: room.name,
    goal: room.goal ?? null,
    visibility: room.visibility,
  })
}

export function registerStationTools(server: McpServer): void {
  server.registerTool(
    'quoroom_station_create',
    {
      title: 'Create Station',
      description: 'Rent a cloud server (station) for the room via quoroom.ai. '
        + 'Returns a payment URL — open it in a browser to subscribe with Stripe. '
        + 'For crypto payment (USDC), use quoroom_station_create_crypto instead. '
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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
    'quoroom_station_cancel',
    {
      title: 'Cancel Station',
      description: 'Cancel a station subscription at end of billing period. '
        + 'The station keeps running until the period ends, then stops automatically. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID to cancel')
      }
    },
    async ({ roomId, id }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      await cancelCloudStation(cloudRoomId, id)
      return {
        content: [{
          type: 'text' as const,
          text: `Station ${id} cancellation requested (will stop at end of billing period).`
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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
      await bootstrapRoomToken(roomId)
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

  // ─── Crypto payment tools ──────────────────────────────────

  server.registerTool(
    'quoroom_station_create_crypto',
    {
      title: 'Create Station (Crypto)',
      description: 'Pay for a new station with USDC from the room wallet. '
        + 'Sends USDC to the Quoroom treasury and provisions the station automatically. '
        + 'Requires the room to have a wallet with sufficient USDC balance. '
        + 'Crypto prices are 1.5x Stripe prices (micro $7.50, small $22.50, medium $60, large $150). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        name: z.string().min(1).max(100).describe('Station name (e.g., "web-server", "scraper-01")'),
        tier: z.enum(['micro', 'small', 'medium', 'large']).describe(
          'Station tier: micro ($7.50/mo crypto), small ($22.50/mo), medium ($60/mo), large ($150/mo)'
        ),
        encryptionKey: z.string().min(1).describe('Wallet encryption key for sending USDC'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, name, tier, encryptionKey, network }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)

      // Step 1: Get crypto pricing from cloud
      const pricing = await getCloudCryptoPrices(cloudRoomId)
      if (!pricing) {
        return { content: [{ type: 'text' as const, text: 'Crypto payments are not available.' }], isError: true }
      }

      const tierInfo = pricing.tiers.find(t => t.tier === tier)
      if (!tierInfo) {
        return { content: [{ type: 'text' as const, text: `Unknown tier: ${tier}` }], isError: true }
      }

      // Step 2: Send USDC to treasury
      const db = getMcpDatabase()
      let txHash: string
      try {
        txHash = await sendUSDC(
          db, roomId, pricing.treasuryAddress,
          tierInfo.cryptoPrice.toString(), encryptionKey,
          (network as 'base' | 'base-sepolia') ?? 'base'
        )
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `USDC transfer failed: ${(e as Error).message}` }],
          isError: true
        }
      }

      // Step 3: Submit tx hash to cloud for verification + provisioning
      const result = await cryptoCheckoutStation(cloudRoomId, tier, name, txHash)
      if (!result.ok) {
        return {
          content: [{
            type: 'text' as const,
            text: `USDC sent (tx: ${txHash}) but provisioning failed: ${result.error}. Contact support with this tx hash.`
          }],
          isError: true
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Station "${name}" (${tier}) provisioned via crypto. `
            + `Paid ${tierInfo.cryptoPrice} USDC, tx: ${txHash}, expires: ${result.currentPeriodEnd}`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_station_renew_crypto',
    {
      title: 'Renew Station (Crypto)',
      description: 'Renew a crypto-paid station subscription by sending USDC. '
        + 'Only works for stations originally paid with crypto. '
        + 'Extends the station by 30 days. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        id: z.number().describe('The station subscription ID to renew'),
        encryptionKey: z.string().min(1).describe('Wallet encryption key for sending USDC'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, id, encryptionKey, network }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)

      // Get the station to find its tier
      const stations = await listCloudStations(cloudRoomId)
      const station = stations.find(s => s.id === id)
      if (!station) {
        return { content: [{ type: 'text' as const, text: `Station ${id} not found.` }], isError: true }
      }

      // Get crypto pricing
      const pricing = await getCloudCryptoPrices(cloudRoomId)
      if (!pricing) {
        return { content: [{ type: 'text' as const, text: 'Crypto payments are not available.' }], isError: true }
      }

      const tierInfo = pricing.tiers.find(t => t.tier === station.tier)
      if (!tierInfo) {
        return { content: [{ type: 'text' as const, text: `Unknown tier: ${station.tier}` }], isError: true }
      }

      // Send USDC
      const db = getMcpDatabase()
      let txHash: string
      try {
        txHash = await sendUSDC(
          db, roomId, pricing.treasuryAddress,
          tierInfo.cryptoPrice.toString(), encryptionKey,
          (network as 'base' | 'base-sepolia') ?? 'base'
        )
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `USDC transfer failed: ${(e as Error).message}` }],
          isError: true
        }
      }

      // Submit renewal
      const result = await cryptoRenewStation(cloudRoomId, id, txHash)
      if (!result.ok) {
        return {
          content: [{
            type: 'text' as const,
            text: `USDC sent (tx: ${txHash}) but renewal failed: ${result.error}. Contact support with this tx hash.`
          }],
          isError: true
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Station ${id} renewed. Paid ${tierInfo.cryptoPrice} USDC, tx: ${txHash}, new expiry: ${result.currentPeriodEnd}`
        }]
      }
    }
  )
}
