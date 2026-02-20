import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

export function registerRunRoutes(router: Router): void {
  router.get('/api/runs', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const runs = queries.listAllRuns(ctx.db, limit)
    return { data: runs }
  })

  router.get('/api/runs/:id', (ctx) => {
    const run = queries.getTaskRun(ctx.db, Number(ctx.params.id))
    if (!run) return { status: 404, error: 'Run not found' }
    return { data: run }
  })

  router.get('/api/runs/:id/logs', (ctx) => {
    const afterSeq = ctx.query.afterSeq ? Number(ctx.query.afterSeq) : undefined
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const logs = queries.getConsoleLogs(ctx.db, Number(ctx.params.id), afterSeq, limit)
    return { data: logs }
  })
}
