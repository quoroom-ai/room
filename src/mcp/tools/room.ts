import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { createRoom, pauseRoom, restartRoom, deleteRoom, getRoomStatus } from '../../shared/room'
import { QUEEN_DEFAULTS_BY_PLAN, CHATGPT_DEFAULTS_BY_PLAN } from '../../shared/constants'
import type { ClaudePlan, ChatGptPlan } from '../../shared/constants'

export function registerRoomTools(server: McpServer): void {
  server.registerTool(
    'quoroom_create_room',
    {
      title: 'Create Room',
      description: 'Create a new Room — an autonomous agent collective with a queen, goal, and quorum governance. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        name: z.string().min(1).max(200).regex(/^\S+$/, 'name must be a single word').describe('Name for the room — single lowercase word (e.g., "saasbuilder", "freelancer")'),
        goal: z.string().max(1000).optional().describe('The room\'s objective (e.g., "Build profitable micro-SaaS tools")'),
        queenSystemPrompt: z.string().max(50000).optional().describe('Custom system prompt for the queen agent. If omitted, uses default.'),
        threshold: z.enum(['majority', 'supermajority', 'unanimous']).optional().describe('Quorum voting threshold (default: majority)'),
        timeoutMinutes: z.number().int().positive().optional().describe('Quorum vote timeout in minutes (default: 60)')
      }
    },
    async ({ name, goal, queenSystemPrompt, threshold, timeoutMinutes }) => {
      const db = getMcpDatabase()
      const normalizedName = name.toLowerCase()
      const config: Record<string, unknown> = {}
      if (threshold) config.threshold = threshold
      if (timeoutMinutes) config.timeoutMinutes = timeoutMinutes
      const result = createRoom(db, { name: normalizedName, goal, queenSystemPrompt, config: config as Parameters<typeof createRoom>[1]['config'] })
      // Apply plan-aware defaults for queen activity limits
      const globalQueenModel = queries.getSetting(db, 'queen_model')
      let planDefaults: { queenCycleGapMs: number; queenMaxTurns: number }
      if (globalQueenModel === 'codex') {
        const raw = queries.getSetting(db, 'chatgpt_plan') ?? ''
        const plan = (raw in CHATGPT_DEFAULTS_BY_PLAN ? raw : 'none') as ChatGptPlan
        planDefaults = CHATGPT_DEFAULTS_BY_PLAN[plan]
      } else {
        const raw = queries.getSetting(db, 'claude_plan') ?? ''
        const plan = (raw in QUEEN_DEFAULTS_BY_PLAN ? raw : 'none') as ClaudePlan
        planDefaults = QUEEN_DEFAULTS_BY_PLAN[plan]
      }
      queries.updateRoom(db, result.room.id, { ...planDefaults, workerModel: 'queen' })
      if (globalQueenModel) {
        queries.updateWorker(db, result.queen.id, { model: globalQueenModel })
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Created room "${normalizedName}" (id: ${result.room.id}) with queen "${result.queen.name}"${goal ? ` and objective: ${goal}` : ''}.`
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

  server.registerTool(
    'quoroom_configure_room',
    {
      title: 'Configure Room',
      description: 'Modify a room\'s execution and governance parameters. '
        + 'Use this to self-regulate resource usage or to adjust quorum rules (voting thresholds, sealed ballots, voter health). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        queenCycleGapMs: z.number().int().min(1000).max(3600000).optional()
          .describe('Milliseconds between queen cycles (1000ms–3600000ms / 1s–60min)'),
        queenMaxTurns: z.number().int().min(1).max(50).optional()
          .describe('Maximum agentic turns per queen cycle (1–50)'),
        maxConcurrentTasks: z.number().int().min(1).max(10).optional()
          .describe('Maximum parallel tasks (1–10)'),
        threshold: z.enum(['majority', 'supermajority', 'unanimous']).optional()
          .describe('Voting threshold for quorum decisions'),
        autoApprove: z.array(z.string()).optional()
          .describe('Decision types to auto-approve without voting (e.g. ["low_impact"])'),
        tieBreaker: z.enum(['queen', 'none']).optional()
          .describe('Tie-breaking strategy: queen vote decides, or reject on tie'),
        minVoters: z.number().int().min(0).max(100).optional()
          .describe('Minimum non-abstain votes required for a decision to pass (0 = no minimum)'),
        sealedBallot: z.boolean().optional()
          .describe('When true, individual votes are hidden until the decision resolves'),
        voterHealth: z.boolean().optional()
          .describe('Enable voter health tracking — monitors worker participation rates'),
        voterHealthThreshold: z.number().min(0).max(1).optional()
          .describe('Participation rate threshold (0.0–1.0) below which workers are flagged as unhealthy')
      }
    },
    async ({ roomId, queenCycleGapMs, queenMaxTurns, maxConcurrentTasks,
             threshold, autoApprove, tieBreaker,
             minVoters, sealedBallot, voterHealth, voterHealthThreshold }) => {
      const db = getMcpDatabase()
      const room = queries.getRoom(db, roomId)
      if (!room) {
        return { content: [{ type: 'text' as const, text: `Room ${roomId} not found.` }], isError: true }
      }

      const updates: Record<string, unknown> = {}
      const changes: string[] = []

      // Execution params
      if (queenCycleGapMs !== undefined) {
        updates.queenCycleGapMs = queenCycleGapMs
        changes.push(`cycleGap: ${Math.round(room.queenCycleGapMs / 1000)}s → ${Math.round(queenCycleGapMs / 1000)}s`)
      }
      if (queenMaxTurns !== undefined) {
        updates.queenMaxTurns = queenMaxTurns
        changes.push(`maxTurns: ${room.queenMaxTurns} → ${queenMaxTurns}`)
      }
      if (maxConcurrentTasks !== undefined) {
        updates.maxConcurrentTasks = maxConcurrentTasks
        changes.push(`concurrentTasks: ${room.maxConcurrentTasks} → ${maxConcurrentTasks}`)
      }

      // Governance params (stored in room.config JSON)
      const configUpdates: Record<string, unknown> = {}
      if (threshold !== undefined) {
        configUpdates.threshold = threshold
        changes.push(`threshold: ${room.config.threshold} → ${threshold}`)
      }
      if (autoApprove !== undefined) {
        configUpdates.autoApprove = autoApprove
        changes.push(`autoApprove: [${room.config.autoApprove.join(',')}] → [${autoApprove.join(',')}]`)
      }
      if (tieBreaker !== undefined) {
        configUpdates.tieBreaker = tieBreaker
        changes.push(`tieBreaker: ${room.config.tieBreaker} → ${tieBreaker}`)
      }
      if (minVoters !== undefined) {
        configUpdates.minVoters = minVoters
        changes.push(`minVoters: ${room.config.minVoters} → ${minVoters}`)
      }
      if (sealedBallot !== undefined) {
        configUpdates.sealedBallot = sealedBallot
        changes.push(`sealedBallot: ${room.config.sealedBallot} → ${sealedBallot}`)
      }
      if (voterHealth !== undefined) {
        configUpdates.voterHealth = voterHealth
        changes.push(`voterHealth: ${room.config.voterHealth} → ${voterHealth}`)
      }
      if (voterHealthThreshold !== undefined) {
        configUpdates.voterHealthThreshold = voterHealthThreshold
        changes.push(`voterHealthThreshold: ${room.config.voterHealthThreshold} → ${voterHealthThreshold}`)
      }

      if (changes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No changes specified.' }] }
      }

      // Merge config updates into existing config
      if (Object.keys(configUpdates).length > 0) {
        updates.config = { ...room.config, ...configUpdates }
      }

      queries.updateRoom(db, roomId, updates)

      queries.logRoomActivity(db, roomId, 'system',
        `Room config updated: ${changes.join(', ')}`)

      return {
        content: [{
          type: 'text' as const,
          text: `Room ${roomId} updated: ${changes.join(', ')}.`
        }]
      }
    }
  )
}
