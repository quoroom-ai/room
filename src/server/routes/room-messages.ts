import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

export function registerRoomMessageRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/messages', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const status = ctx.query.status as string | undefined
    return { data: queries.listRoomMessages(ctx.db, roomId, status) }
  })

  router.get('/api/messages/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const msg = queries.getRoomMessage(ctx.db, id)
    if (!msg) return { status: 404, error: 'Message not found' }
    return { data: msg }
  })

  router.post('/api/rooms/:roomId/messages/:id/read', (ctx) => {
    const id = Number(ctx.params.id)
    queries.markRoomMessageRead(ctx.db, id)
    return { data: { ok: true } }
  })

  router.delete('/api/messages/:id', (ctx) => {
    const id = Number(ctx.params.id)
    queries.deleteRoomMessage(ctx.db, id)
    return { data: { ok: true } }
  })
}
