import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerWipTools(server: McpServer): void {
  server.registerTool(
    'quoroom_save_wip',
    {
      title: 'Save WIP',
      description:
        'Save what you accomplished this cycle and what should happen next. '
        + 'This is injected at the TOP of your next cycle\'s context so you (or a teammate) can continue forward without repeating work. '
        + 'Call this before your cycle ends. Pass "done" or empty string to clear WIP.',
      inputSchema: {
        workerId: z.number().describe('Your worker ID'),
        status: z.string().max(2000).describe(
          'What you accomplished and what to do next. Example: '
          + '"Registered tuta account (user: agent42@tuta.com, pwd in memory). Next: set up email forwarding and notify keeper." '
          + 'Pass "done" or empty string to clear WIP when action is complete.'
        )
      }
    },
    async ({ workerId, status }) => {
      const db = getMcpDatabase()
      const worker = queries.getWorker(db, workerId)
      if (!worker) {
        return { content: [{ type: 'text' as const, text: `Worker #${workerId} not found.` }], isError: true }
      }
      const trimmed = (status ?? '').trim()
      const isDone = !trimmed || trimmed.toLowerCase() === 'done' || trimmed.toLowerCase() === 'complete' || trimmed.toLowerCase() === 'completed'
      queries.updateWorkerWip(db, workerId, isDone ? null : trimmed.slice(0, 2000))
      return {
        content: [{
          type: 'text' as const,
          text: isDone ? 'WIP cleared.' : 'WIP saved. Next cycle will see it at the top of context.'
        }]
      }
    }
  )
}
