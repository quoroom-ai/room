import os from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerResourceTools(server: McpServer): void {
  server.registerTool(
    'quoroom_resources_get',
    {
      title: 'Get Local Resources',
      description:
        'Get current local machine resource usage: CPU load and RAM usage. '
        + 'Use this to decide if the room needs additional swarm runtime capacity. '
        + 'If CPU load > number of CPUs or RAM used > 85%, consider scaling swarm infrastructure.',
      inputSchema: {}
    },
    async () => {
      const db = getMcpDatabase()

      // CPU and RAM
      const [load1, load5] = os.loadavg()
      const total = os.totalmem()
      const free = os.freemem()
      const cpuCount = os.cpus().length
      const memUsedPct = Math.round((1 - free / total) * 100)

      // Running task count
      let runningTasks = 0
      let maxConcurrentTasks = 3
      try {
        const tasks = queries.listTasks(db)
        runningTasks = tasks.filter(t => t.status === 'active').length
        const setting = queries.getSetting(db, 'max_concurrent_tasks')
        if (setting) maxConcurrentTasks = parseInt(setting, 10) || 3
      } catch { /* non-fatal */ }

      const loadRatio = load1 / cpuCount
      const highLoad = loadRatio > 0.8 || memUsedPct > 85

      const summary = highLoad
        ? `HIGH LOAD — CPU ${Math.round(loadRatio * 100)}% of capacity, RAM ${memUsedPct}% used. Consider scaling swarm runtime if funds allow.`
        : `Normal load — CPU ${Math.round(loadRatio * 100)}% of capacity, RAM ${memUsedPct}% used.`

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            summary,
            highLoad,
            cpu: {
              count: cpuCount,
              loadAvg1m: Math.round(load1 * 100) / 100,
              loadAvg5m: Math.round(load5 * 100) / 100,
              loadPct: Math.round(loadRatio * 100),
            },
            memory: {
              totalGb: Math.round(total / 1024 / 1024 / 1024 * 10) / 10,
              freeGb: Math.round(free / 1024 / 1024 / 1024 * 10) / 10,
              usedPct: memUsedPct,
            },
            tasks: {
              running: runningTasks,
              maxConcurrent: maxConcurrentTasks,
            },
          }, null, 2)
        }]
      }
    }
  )
}
