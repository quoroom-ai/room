import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

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
    const roomId = Number(ctx.params.roomId)
    const id = Number(ctx.params.id)
    const message = queries.getRoomMessage(ctx.db, id)
    if (!message || message.roomId !== roomId) {
      return { status: 404, error: 'Message not found' }
    }

    queries.markRoomMessageRead(ctx.db, id)
    eventBus.emit(`room:${roomId}`, 'room_message:updated', { id, status: 'read' })
    return { data: { ok: true } }
  })

  router.post('/api/messages/:id/reply', (ctx) => {
    const id = Number(ctx.params.id)
    const original = queries.getRoomMessage(ctx.db, id)
    if (!original) return { status: 404, error: 'Message not found' }

    const body = ctx.body as Record<string, unknown> || {}
    const replyBody = typeof body.body === 'string' ? body.body.trim() : ''
    if (!replyBody) return { status: 400, error: 'body is required' }

    const toRoomId = typeof body.toRoomId === 'string' && body.toRoomId.trim()
      ? body.toRoomId.trim()
      : original.fromRoomId
    if (!toRoomId) {
      return { status: 400, error: 'toRoomId is required for this reply' }
    }

    const subject = typeof body.subject === 'string' && body.subject.trim()
      ? body.subject.trim()
      : `Re: ${original.subject}`

    queries.replyToRoomMessage(ctx.db, id)
    const reply = queries.createRoomMessage(
      ctx.db,
      original.roomId,
      'outbound',
      subject,
      replyBody,
      { toRoomId }
    )

    eventBus.emit(`room:${original.roomId}`, 'room_message:updated', { id, status: 'replied' })
    eventBus.emit(`room:${original.roomId}`, 'room_message:created', reply)
    return { status: 201, data: reply }
  })

  router.delete('/api/messages/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const message = queries.getRoomMessage(ctx.db, id)
    if (!message) return { status: 404, error: 'Message not found' }

    queries.deleteRoomMessage(ctx.db, id)
    eventBus.emit(`room:${message.roomId}`, 'room_message:deleted', { id })
    return { data: { ok: true } }
  })
}
