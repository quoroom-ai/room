import os from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { isOllamaAvailable, listOllamaModels } from '../../shared/agent-executor'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'

export function registerResourceTools(server: McpServer): void {
  server.registerTool(
    'quoroom_resources_get',
    {
      title: 'Get Local Resources',
      description:
        'Get current local machine resource usage: CPU load, RAM usage, Ollama status, and wallet balance. '
        + 'Use this to decide if the room needs to rent a cloud station for extra compute. '
        + 'If CPU load > number of CPUs or RAM used > 85%, consider proposing a station rental to the quorum. '
        + 'Check wallet balance first — only propose if there are enough funds (station costs $5–100/month).',
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

      // Ollama
      const ollamaAvailable = await isOllamaAvailable()
      const ollamaModels = ollamaAvailable ? await listOllamaModels() : []

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
        ? `HIGH LOAD — CPU ${Math.round(loadRatio * 100)}% of capacity, RAM ${memUsedPct}% used. Consider proposing a station rental if funds allow.`
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
            ollama: {
              available: ollamaAvailable,
              models: ollamaModels.map(m => m.name),
            },
          }, null, 2)
        }]
      }
    }
  )
}
