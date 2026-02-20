import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerSettingsTools(server: McpServer): void {
  server.registerTool(
    'quoroom_get_setting',
    {
      title: 'Get Setting',
      description: 'Get a Quoroom setting value by key. '
        + 'Available settings: large_window_enabled (true/false) — use a larger popover window in the Quoroom desktop app. '
        + 'max_concurrent_tasks (integer, 1-10, default: 3) — how many tasks the queen can work on at once.',
      inputSchema: {
        key: z.string().describe('The setting key (e.g. "max_concurrent_tasks")')
      }
    },
    async ({ key }) => {
      const db = getMcpDatabase()
      const value = queries.getSetting(db, key)
      return {
        content: [{
          type: 'text' as const,
          text: value !== null
            ? `Setting "${key}" = "${value}"`
            : `Setting "${key}" is not set (default behavior applies).`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_set_setting',
    {
      title: 'Set Setting',
      description: 'Set a Quoroom setting. '
        + 'Available settings: large_window_enabled (true/false) — use a larger popover window in the Quoroom desktop app. '
        + 'max_concurrent_tasks (integer, 1-10, default: 3) — how many tasks the queen can work on at once. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        key: z.string().describe('The setting key'),
        value: z.string().describe('The setting value')
      }
    },
    async ({ key, value }) => {
      const db = getMcpDatabase()
      queries.setSetting(db, key, value)
      return {
        content: [{
          type: 'text' as const,
          text: `Set "${key}" to "${value}".`
        }]
      }
    }
  )
}
