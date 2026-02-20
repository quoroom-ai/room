import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { validateWatchPath } from '../../shared/watch-path'

export function registerWatcherTools(server: McpServer): void {
  server.registerTool(
    'quoroom_watch',
    {
      title: 'Watch Folder',
      description:
        'Watch a file or folder for changes. When a new file is added or a file is modified, Quoroom will execute the action prompt using Claude Code CLI. The watcher runs in the Quoroom background process. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the file or folder to watch'),
        description: z.string().max(500).optional().describe('Description of what this watch does'),
        actionPrompt: z
          .string()
          .max(50000)
          .describe('The prompt/instruction for Claude to execute when a change is detected'),
        roomId: z.number().int().positive().optional().describe(
          'Assign this watch to a room by ID. When set, the watch is scoped to that room.'
        )
      }
    },
    async ({ path, description, actionPrompt, roomId }) => {
      const pathError = validateWatchPath(path)
      if (pathError) {
        return {
          content: [{ type: 'text' as const, text: `Invalid watch path: ${pathError}` }]
        }
      }

      const db = getMcpDatabase()
      queries.createWatch(db, path, description, actionPrompt, roomId)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Watching "${path}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_unwatch',
    {
      title: 'Stop Watching',
      description: 'Stop watching a file or folder by its watch ID. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The watch ID to remove')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const watch = queries.getWatch(db, id)
      if (!watch) {
        return {
          content: [{ type: 'text' as const, text: `No watch found with id ${id}.` }]
        }
      }
      queries.deleteWatch(db, id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Stopped watching "${watch.path}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_pause_watch',
    {
      title: 'Pause Watch',
      description: 'Pause a file/folder watch by its ID. The watch will stop triggering until resumed. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The watch ID to pause')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const watch = queries.getWatch(db, id)
      if (!watch) {
        return {
          content: [{ type: 'text' as const, text: `No watch found with id ${id}.` }]
        }
      }
      queries.pauseWatch(db, id)
      return {
        content: [{ type: 'text' as const, text: `Paused watch on "${watch.path}".` }]
      }
    }
  )

  server.registerTool(
    'quoroom_resume_watch',
    {
      title: 'Resume Watch',
      description: 'Resume a paused file/folder watch by its ID. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The watch ID to resume')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const watch = queries.getWatch(db, id)
      if (!watch) {
        return {
          content: [{ type: 'text' as const, text: `No watch found with id ${id}.` }]
        }
      }
      queries.resumeWatch(db, id)
      return {
        content: [{ type: 'text' as const, text: `Resumed watch on "${watch.path}".` }]
      }
    }
  )

  server.registerTool(
    'quoroom_list_watches',
    {
      title: 'List Watches',
      description: 'List all active file/folder watches.',
      inputSchema: {}
    },
    async () => {
      const db = getMcpDatabase()
      const rows = queries.listWatches(db)

      if (rows.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No active watches.' }]
        }
      }

      const list = rows.map((row) => ({
        id: row.id,
        path: row.path,
        description: row.description,
        status: row.status,
        triggerCount: row.triggerCount,
        lastTriggered: row.lastTriggered
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(list, null, 2)
          }
        ]
      }
    }
  )
}
