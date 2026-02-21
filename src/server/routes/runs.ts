import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import type { TaskRun } from '../../shared/types'

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}

export function registerRunRoutes(router: Router): void {
  router.get('/api/runs', (ctx) => {
    const limit = parseLimit(ctx.query.limit, 20, 500)
    const status = ctx.query.status
    const includeResult = ctx.query.includeResult === '1'
    let runs: TaskRun[]

    if (status === 'running') {
      runs = queries.getRunningTaskRuns(ctx.db).slice(0, limit)
    } else if (status) {
      runs = queries.listAllRuns(ctx.db, limit).filter((run) => run.status === status)
    } else {
      runs = queries.listAllRuns(ctx.db, limit)
    }

    if (!includeResult) {
      runs = runs.map((run) => ({ ...run, result: null }))
    }
    return { data: runs }
  })

  router.get('/api/runs/:id', (ctx) => {
    const run = queries.getTaskRun(ctx.db, Number(ctx.params.id))
    if (!run) return { status: 404, error: 'Run not found' }
    return { data: run }
  })

  router.get('/api/runs/:id/logs', (ctx) => {
    const afterSeq = ctx.query.afterSeq ? Number(ctx.query.afterSeq) : undefined
    const limit = parseLimit(ctx.query.limit, 100, 1000)
    const logs = queries.getConsoleLogs(ctx.db, Number(ctx.params.id), afterSeq, limit)
    return { data: logs }
  })
}
