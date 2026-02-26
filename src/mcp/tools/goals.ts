import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { setRoomObjective, decomposeGoal, updateGoalProgress, completeGoal, abandonGoal, getGoalTree } from '../../shared/goals'
import { nudgeWorker } from '../nudge'

export function registerGoalTools(server: McpServer): void {
  server.registerTool(
    'quoroom_set_goal',
    {
      title: 'Set Room Goal',
      description: 'Set or update the room\'s primary objective. Creates a new top-level goal. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        description: z.string().min(1).max(2000).describe('The objective description')
      }
    },
    async ({ roomId, description }) => {
      const db = getMcpDatabase()
      const goal = setRoomObjective(db, roomId, description)
      queries.updateRoom(db, roomId, { goal: description })
      return { content: [{ type: 'text' as const, text: `Goal set: "${description}" (id: ${goal.id})` }] }
    }
  )

  server.registerTool(
    'quoroom_create_subgoal',
    {
      title: 'Create Sub-goal',
      description: 'Decompose a goal into sub-goals. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        goalId: z.number().describe('The parent goal ID'),
        descriptions: z.array(z.string().min(1).max(2000)).min(1).max(20)
          .describe('Array of sub-goal descriptions')
      }
    },
    async ({ goalId, descriptions }) => {
      const db = getMcpDatabase()
      try {
        const subGoals = decomposeGoal(db, goalId, descriptions)
        return { content: [{ type: 'text' as const, text: `Created ${subGoals.length} sub-goal(s) under goal #${goalId}.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_update_progress',
    {
      title: 'Update Goal Progress',
      description: 'Log a progress observation on a goal. Optionally set a metric value (0.0 to 1.0). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        goalId: z.number().describe('The goal ID'),
        observation: z.string().min(1).max(2000).describe('Description of progress'),
        metricValue: z.number().min(0).max(1).optional().describe('Progress value from 0.0 to 1.0'),
        workerId: z.number().optional().describe('Worker ID reporting progress')
      }
    },
    async ({ goalId, observation, metricValue, workerId }) => {
      const db = getMcpDatabase()
      try {
        updateGoalProgress(db, goalId, observation, metricValue, workerId)
        return { content: [{ type: 'text' as const, text: `Progress logged on goal #${goalId}.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_delegate_task',
    {
      title: 'Delegate Task',
      description: 'Delegate a task to a specific worker. Creates a goal assigned to that worker. '
        + 'The worker will see it in their "Your Assigned Tasks" context. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        workerName: z.string().min(1).describe('Worker name to assign to (from Room Workers list)'),
        task: z.string().min(1).max(2000).describe('Task description'),
        parentGoalId: z.number().optional().describe('Parent goal ID to attach as sub-goal')
      }
    },
    async ({ roomId, workerName, task, parentGoalId }) => {
      const db = getMcpDatabase()
      try {
        const workers = queries.listRoomWorkers(db, roomId)
        const target = queries.findWorkerByName(workers, workerName)
        if (!target) {
          const available = workers.map(w => w.name).join(', ')
          return { content: [{ type: 'text' as const, text: `Worker "${workerName}" not found. Available: ${available || 'none'}` }], isError: true }
        }
        if (parentGoalId != null) {
          const parent = queries.getGoal(db, parentGoalId)
          if (!parent) return { content: [{ type: 'text' as const, text: `Parent goal #${parentGoalId} not found.` }], isError: true }
          if (parent.status === 'active') queries.updateGoal(db, parentGoalId, { status: 'in_progress' })
        }
        const goal = queries.createGoal(db, roomId, task, parentGoalId, target.id)
        // Wake the assigned worker so they pick up the task
        nudgeWorker(target.id)
        return { content: [{ type: 'text' as const, text: `Task delegated to ${target.name}: "${task}" (goal #${goal.id})` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_complete_goal',
    {
      title: 'Complete Goal',
      description: 'Mark a goal as completed (100% progress). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        goalId: z.number().describe('The goal ID to complete')
      }
    },
    async ({ goalId }) => {
      const db = getMcpDatabase()
      try {
        completeGoal(db, goalId)
        return { content: [{ type: 'text' as const, text: `Goal #${goalId} marked as completed.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_abandon_goal',
    {
      title: 'Abandon Goal',
      description: 'Mark a goal as abandoned with a reason. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        goalId: z.number().describe('The goal ID to abandon'),
        reason: z.string().min(1).max(1000).describe('Reason for abandoning')
      }
    },
    async ({ goalId, reason }) => {
      const db = getMcpDatabase()
      try {
        abandonGoal(db, goalId, reason)
        return { content: [{ type: 'text' as const, text: `Goal #${goalId} abandoned: ${reason}` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_list_goals',
    {
      title: 'List Goals',
      description: 'List goals for a room as a hierarchical tree.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      const db = getMcpDatabase()
      const tree = getGoalTree(db, roomId)
      if (tree.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No goals set.' }] }
      }
      function formatTree(nodes: typeof tree, indent: number = 0): string {
        return nodes.map(n => {
          const prefix = '  '.repeat(indent)
          const line = `${prefix}- ${n.description} (${n.status})`
          const children = n.children.length > 0 ? '\n' + formatTree(n.children, indent + 1) : ''
          return line + children
        }).join('\n')
      }
      return { content: [{ type: 'text' as const, text: formatTree(tree) }] }
    }
  )
}
