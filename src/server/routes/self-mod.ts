import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { revertModification } from '../../shared/self-mod'

export function registerSelfModRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/self-mod', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const history = queries.getSelfModHistory(ctx.db, roomId, limit)
    return { data: history }
  })

  // Client-facing routes (used by UI client)
  router.get('/api/self-mod/audit', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    if (!roomId) return { data: [] }
    const history = queries.getSelfModHistory(ctx.db, roomId)
    return { data: history }
  })

  router.post('/api/self-mod/audit/:id/revert', (ctx) => {
    const id = Number(ctx.params.id)
    revertModification(ctx.db, id)
    return { data: { ok: true } }
  })
}
