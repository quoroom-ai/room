import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerWorkerTools(server: McpServer): void {
  server.registerTool(
    'quoroom_create_worker',
    {
      title: 'Create Worker',
      description:
        'Create a named agent configuration (worker) with a system prompt that defines personality, capabilities, and constraints. '
        + 'Tasks can be assigned to workers. The worker\'s system prompt is passed to Claude CLI via --system-prompt on every task run. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        roomId: z.number().optional().describe('Optional room to scope this worker to'),
        name: z.string().min(1).max(200).describe('Name for the worker — can be a personal name (e.g., "John", "Ada") or a role title (e.g., "Research Assistant")'),
        role: z.string().min(1).max(200).optional().describe('Optional role/function title (e.g., "Chief of Staff", "Code Reviewer"). Shown as subtitle under the name.'),
        systemPrompt: z.string().min(1).max(50000).describe(
          'The system prompt / "soul" that defines this worker\'s personality, capabilities, and constraints. '
          + 'This is passed via --system-prompt to every task assigned to this worker.'
        ),
        description: z.string().max(1000).optional().describe('Optional short description of what this worker does'),
        isDefault: z.boolean().optional().describe(
          'Set as the default worker. The default worker is used for tasks without a specific worker assignment. Only one worker can be default.'
        )
      }
    },
    async ({ roomId, name, role, systemPrompt, description, isDefault }) => {
      const db = getMcpDatabase()
      if (roomId != null && !queries.getRoom(db, roomId)) {
        return { content: [{ type: 'text' as const, text: `No room found with id ${roomId}.` }], isError: true }
      }
      queries.createWorker(db, { name, role, systemPrompt, description, isDefault, roomId: roomId ?? undefined })
      const label = role ? `"${name}" (${role})` : `"${name}"`
      return {
        content: [{
          type: 'text' as const,
          text: `Created worker ${label}.`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_list_workers',
    {
      title: 'List Workers',
      description: 'List all worker configurations.',
      inputSchema: {
        roomId: z.number().optional().describe('Optional room scope filter')
      }
    },
    async ({ roomId }: { roomId?: number }) => {
      const db = getMcpDatabase()
      const workers = roomId != null ? queries.listRoomWorkers(db, roomId) : queries.listWorkers(db)
      if (workers.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No workers configured.' }] }
      }
      const list = workers.map(w => ({
        id: w.id,
        name: w.name,
        role: w.role,
        description: w.description,
        isDefault: w.isDefault,
        taskCount: w.taskCount,
        systemPromptPreview: w.systemPrompt.substring(0, 100) + (w.systemPrompt.length > 100 ? '...' : ''),
        createdAt: w.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_update_worker',
    {
      title: 'Update Worker',
      description: 'Update a worker\'s name, role, system prompt, description, or default status. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        roomId: z.number().optional().describe('Optional room scope guard (recommended for queen flows)'),
        id: z.number().describe('The worker ID to update'),
        name: z.string().optional().describe('New name'),
        role: z.string().optional().describe('New role/function title'),
        systemPrompt: z.string().optional().describe('New system prompt'),
        description: z.string().optional().describe('New description'),
        isDefault: z.boolean().optional().describe('Set or unset as default worker')
      }
    },
    async ({ roomId, id, name, role, systemPrompt, description, isDefault }) => {
      const db = getMcpDatabase()
      const worker = queries.getWorker(db, id)
      if (!worker) {
        return { content: [{ type: 'text' as const, text: `No worker found with id ${id}.` }] }
      }
      if (roomId != null && worker.roomId !== roomId) {
        return { content: [{ type: 'text' as const, text: `Worker ${id} does not belong to room ${roomId}.` }], isError: true }
      }
      const updates: Record<string, unknown> = {}
      if (name !== undefined) updates.name = name
      if (role !== undefined) updates.role = role
      if (systemPrompt !== undefined) updates.systemPrompt = systemPrompt
      if (description !== undefined) updates.description = description
      if (isDefault !== undefined) updates.isDefault = isDefault
      queries.updateWorker(db, id, updates)
      return { content: [{ type: 'text' as const, text: `Updated worker "${worker.name}".` }] }
    }
  )

  server.registerTool(
    'quoroom_delete_worker',
    {
      title: 'Delete Worker',
      description: 'Delete a worker configuration. Tasks assigned to this worker will have their worker unset. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        roomId: z.number().optional().describe('Optional room scope guard (recommended for queen flows)'),
        id: z.number().describe('The worker ID to delete')
      }
    },
    async ({ roomId, id }) => {
      const db = getMcpDatabase()
      const worker = queries.getWorker(db, id)
      if (!worker) {
        return { content: [{ type: 'text' as const, text: `No worker found with id ${id}.` }] }
      }
      if (roomId != null && worker.roomId !== roomId) {
        return { content: [{ type: 'text' as const, text: `Worker ${id} does not belong to room ${roomId}.` }], isError: true }
      }
      queries.deleteWorker(db, id)
      return { content: [{ type: 'text' as const, text: `Deleted worker "${worker.name}".` }] }
    }
  )
}
