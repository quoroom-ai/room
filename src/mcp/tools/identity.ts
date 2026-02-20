import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import { registerRoomIdentity, getRoomIdentity, updateRoomIdentityURI } from '../../shared/identity'

export function registerIdentityTools(server: McpServer): void {
  server.registerTool(
    'quoroom_identity_register',
    {
      title: 'Register On-Chain Identity',
      description: 'Register a room as an ERC-8004 on-chain agent identity on Base. '
        + 'Mints an identity NFT linked to the room\'s wallet. Requires the room to have a wallet. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID to register'),
        encryptionKey: z.string().min(1).describe('Wallet encryption key (same as used when creating the wallet)'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, encryptionKey, network }) => {
      const db = getMcpDatabase()
      try {
        const result = await registerRoomIdentity(db, roomId, encryptionKey, network as 'base' | 'base-sepolia' | undefined)
        return {
          content: [{
            type: 'text' as const,
            text: `Identity registered for room ${roomId}: agentId ${result.agentId} (tx: ${result.txHash})`
          }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_identity_get',
    {
      title: 'Get On-Chain Identity',
      description: 'Get a room\'s ERC-8004 on-chain identity (agentId, registry, URI). Returns null if not registered.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, network }) => {
      const db = getMcpDatabase()
      try {
        const identity = await getRoomIdentity(db, roomId, network as 'base' | 'base-sepolia' | undefined)
        if (!identity) {
          return { content: [{ type: 'text' as const, text: 'No on-chain identity registered for this room.' }] }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(identity, null, 2) }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_identity_update',
    {
      title: 'Update Identity Metadata',
      description: 'Update the on-chain registration metadata to reflect the current room state (name, workers, goals). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        encryptionKey: z.string().min(1).describe('Wallet encryption key'),
        network: z.enum(['base', 'base-sepolia']).optional().describe('Network (default: base)')
      }
    },
    async ({ roomId, encryptionKey, network }) => {
      const db = getMcpDatabase()
      try {
        const txHash = await updateRoomIdentityURI(db, roomId, encryptionKey, network as 'base' | 'base-sepolia' | undefined)
        return {
          content: [{ type: 'text' as const, text: `Identity metadata updated for room ${roomId} (tx: ${txHash})` }]
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )
}
