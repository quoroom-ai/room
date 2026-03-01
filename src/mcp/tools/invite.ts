import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import {
  getRoomCloudId,
  ensureCloudRoomToken,
  createCloudInvite,
  listCloudInvites,
  fetchReferredRooms,
} from '../../shared/cloud-sync'

async function bootstrapRoomToken(roomId: number): Promise<void> {
  const db = getMcpDatabase()
  const room = queries.getRoom(db, roomId)
  if (!room) return
  await ensureCloudRoomToken({
    roomId: getRoomCloudId(roomId),
    name: room.name,
    goal: room.goal ?? null,
    visibility: room.visibility,
    referredByCode: room.referredByCode,
    keeperReferralCode: queries.getSetting(db, 'keeper_referral_code'),
  })
}

export function registerInviteTools(server: McpServer): void {
  server.registerTool(
    'quoroom_invite_create',
    {
      title: 'Create Invite Link',
      description: 'Create an invite link for this room. '
        + 'Rooms created through this link join your network — '
        + 'you can exchange knowledge, discover opportunities, and propose deals with them. '
        + 'RESPONSE STYLE: Return the invite URL and a brief note about sharing it.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        maxUses: z.number().int().positive().optional()
          .describe('Maximum number of times the invite can be used (unlimited if omitted)'),
        expiresInDays: z.number().int().positive().max(365).optional()
          .describe('Number of days until the invite expires (never if omitted)')
      }
    },
    async ({ roomId, maxUses, expiresInDays }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const result = await createCloudInvite(cloudRoomId, { maxUses, expiresInDays })
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'Failed to create invite link. Cloud may be unavailable.' }],
          isError: true
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Invite link created: ${result.inviteUrl}\n\nShare this with the keeper or potential collaborators. Rooms created through this link will join your network.`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_invite_list',
    {
      title: 'List Invite Links',
      description: 'List all invite links for this room with usage statistics.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const invites = await listCloudInvites(cloudRoomId)
      if (invites.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No invite links found. Create one with quoroom_invite_create.' }] }
      }
      const list = invites.map(inv => ({
        code: inv.inviteCode,
        url: inv.inviteUrl,
        used: inv.usedCount,
        maxUses: inv.maxUses,
        active: inv.isActive,
        expiresAt: inv.expiresAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_invite_network',
    {
      title: 'View Network',
      description: 'See rooms in your network — rooms created through your invite links. '
        + 'Public rooms show full data (name, goal, workers, earnings). '
        + 'Private rooms show only that they exist.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const rooms = await fetchReferredRooms(cloudRoomId)
      if (rooms.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No rooms in your network yet. Create an invite link with quoroom_invite_create and share it to grow your network.'
          }]
        }
      }
      const summary = [
        `Network: ${rooms.length} room${rooms.length === 1 ? '' : 's'}`,
        '',
        ...rooms.map(r => {
          if (r.visibility === 'private') {
            return `- [Private room] (${r.roomId})`
          }
          const parts = [r.name || r.roomId]
          if (r.goal) parts.push(`Goal: ${r.goal}`)
          if (r.workerCount) parts.push(`${r.workerCount} workers`)
          if (r.taskCount) parts.push(`${r.taskCount} tasks`)
          if (r.earnings && r.earnings !== '0') parts.push(`Earnings: $${r.earnings}`)
          return `- ${parts.join(' | ')}`
        })
      ].join('\n')
      return { content: [{ type: 'text' as const, text: summary }] }
    }
  )
}
