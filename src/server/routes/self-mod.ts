import type { Router } from '../router'
import { eventBus } from '../event-bus'
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
    const entry = queries.getSelfModEntry(ctx.db, id)
    revertModification(ctx.db, id)
    if (entry?.roomId) {
      eventBus.emit(`room:${entry.roomId}`, 'self_mod:reverted', { roomId: entry.roomId, auditId: id })
    }
    return { data: { ok: true } }
  })
}
