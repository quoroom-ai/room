import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { createRoom, pauseRoom, restartRoom, deleteRoom, getRoomStatus } from '../../shared/room'

export function registerRoomTools(server: McpServer): void {
  server.registerTool(
    'quoroom_create_room',
    {
      title: 'Create Room',
      description: 'Create a new Room — an autonomous agent collective with a queen, goal, and quorum governance. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('Name for the room (e.g., "SaaS Builder", "Freelance Coder")'),
        goal: z.string().max(1000).optional().describe('The room\'s objective (e.g., "Build profitable micro-SaaS tools")'),
        queenSystemPrompt: z.string().max(50000).optional().describe('Custom system prompt for the queen agent. If omitted, uses default.'),
        threshold: z.enum(['majority', 'supermajority', 'unanimous']).optional().describe('Quorum voting threshold (default: majority)'),
        timeoutMinutes: z.number().int().positive().optional().describe('Quorum vote timeout in minutes (default: 60)')
      }
    },
    async ({ name, goal, queenSystemPrompt, threshold, timeoutMinutes }) => {
      const db = getMcpDatabase()
      const config: Record<string, unknown> = {}
      if (threshold) config.threshold = threshold
      if (timeoutMinutes) config.timeoutMinutes = timeoutMinutes
      const result = createRoom(db, { name, goal, queenSystemPrompt, config: config as Parameters<typeof createRoom>[1]['config'] })
      return {
        content: [{
          type: 'text' as const,
          text: `Created room "${name}" (id: ${result.room.id}) with queen "${result.queen.name}"${goal ? ` and objective: ${goal}` : ''}.`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_list_rooms',
    {
      title: 'List Rooms',
      description: 'List all rooms, optionally filtered by status.',
      inputSchema: {
        status: z.enum(['active', 'paused', 'stopped']).optional().describe('Filter by status')
      }
    },
    async ({ status }) => {
      const db = getMcpDatabase()
      const rooms = queries.listRooms(db, status)
      if (rooms.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No rooms found.' }] }
      }
      const list = rooms.map(r => ({
        id: r.id, name: r.name, status: r.status,
        goal: r.goal, visibility: r.visibility, createdAt: r.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_pause_room',
    {
      title: 'Pause Room',
      description: 'Pause a room — all agents stop cycling. State is preserved. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The room ID to pause')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        pauseRoom(db, id)
        return { content: [{ type: 'text' as const, text: `Room ${id} paused.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_restart_room',
    {
      title: 'Restart Room',
      description: 'Hard stop — wipes goals, decisions, escalations and restarts the room with an optional new objective. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The room ID to restart'),
        newGoal: z.string().max(1000).optional().describe('New objective for the room')
      }
    },
    async ({ id, newGoal }) => {
      const db = getMcpDatabase()
      try {
        restartRoom(db, id, newGoal)
        return { content: [{ type: 'text' as const, text: `Room ${id} restarted${newGoal ? ` with new objective: ${newGoal}` : ''}.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_delete_room',
    {
      title: 'Delete Room',
      description: 'Permanently delete a room and all its data. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        id: z.number().describe('The room ID to delete')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        deleteRoom(db, id)
        return { content: [{ type: 'text' as const, text: `Room ${id} deleted.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_room_status',
    {
      title: 'Room Status',
      description: 'Get comprehensive status for a room: workers, goals, pending decisions.',
      inputSchema: {
        id: z.number().describe('The room ID')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      try {
        const status = getRoomStatus(db, id)
        const summary = {
          room: { id: status.room.id, name: status.room.name, status: status.room.status, goal: status.room.goal },
          workers: status.workers.map(w => ({ id: w.id, name: w.name, state: w.agentState })),
          activeGoals: status.activeGoals.map(g => ({ id: g.id, description: g.description, progress: g.progress, status: g.status })),
          pendingDecisions: status.pendingDecisions
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_room_activity',
    {
      title: 'Room Activity',
      description: 'Get recent activity feed for a room.',
      inputSchema: {
        id: z.number().describe('The room ID'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum entries to return (default: 50)')
      }
    },
    async ({ id, limit }) => {
      const db = getMcpDatabase()
      const activity = queries.getRoomActivity(db, id, limit ?? 50)
      if (activity.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No activity yet.' }] }
      }
      const list = activity.map(a => ({
        id: a.id, eventType: a.eventType, summary: a.summary, createdAt: a.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )
}
