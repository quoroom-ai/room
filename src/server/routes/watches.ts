import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { validateWatchPath } from '../../shared/watch-path'

export function registerWatchRoutes(router: Router): void {
  router.post('/api/watches', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.path || typeof body.path !== 'string') {
      return { status: 400, error: 'path is required' }
    }
    const pathError = validateWatchPath(body.path)
    if (pathError) {
      return { status: 400, error: pathError }
    }

    const watch = queries.createWatch(ctx.db, body.path,
      body.description as string | undefined,
      body.actionPrompt as string | undefined,
      body.roomId as number | undefined)
    return { status: 201, data: watch }
  })

  router.get('/api/watches', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    const watches = queries.listWatches(ctx.db, roomId, ctx.query.status)
    return { data: watches }
  })

  router.get('/api/watches/:id', (ctx) => {
    const watch = queries.getWatch(ctx.db, Number(ctx.params.id))
    if (!watch) return { status: 404, error: 'Watch not found' }
    return { data: watch }
  })

  router.delete('/api/watches/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const watch = queries.getWatch(ctx.db, id)
    if (!watch) return { status: 404, error: 'Watch not found' }

    queries.deleteWatch(ctx.db, id)
    return { data: { ok: true } }
  })

  router.post('/api/watches/:id/pause', (ctx) => {
    const id = Number(ctx.params.id)
    const watch = queries.getWatch(ctx.db, id)
    if (!watch) return { status: 404, error: 'Watch not found' }

    queries.pauseWatch(ctx.db, id)
    return { data: { ok: true } }
  })

  router.post('/api/watches/:id/resume', (ctx) => {
    const id = Number(ctx.params.id)
    const watch = queries.getWatch(ctx.db, id)
    if (!watch) return { status: 404, error: 'Watch not found' }

    queries.resumeWatch(ctx.db, id)
    return { data: { ok: true } }
  })
}
