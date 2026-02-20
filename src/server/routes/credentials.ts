import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

function maskCredential<T extends { valueEncrypted: string }>(credential: T): T {
  return { ...credential, valueEncrypted: '***' }
}

export function registerCredentialRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/credentials', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    return { data: queries.listCredentials(ctx.db, roomId) }
  })

  router.get('/api/credentials/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const credential = queries.getCredential(ctx.db, id)
    if (!credential) return { status: 404, error: 'Credential not found' }
    return { data: maskCredential(credential) }
  })

  router.post('/api/rooms/:roomId/credentials', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.name || typeof body.name !== 'string') {
      return { status: 400, error: 'name is required' }
    }
    if (!body.value || typeof body.value !== 'string') {
      return { status: 400, error: 'value is required' }
    }

    const credential = queries.createCredential(ctx.db, roomId,
      body.name,
      (body.type as string) || 'other',
      body.value)
    const safeCredential = maskCredential(credential)
    eventBus.emit(`room:${roomId}`, 'credential:created', safeCredential)
    return { status: 201, data: safeCredential }
  })

  router.delete('/api/credentials/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const credential = queries.getCredential(ctx.db, id)
    if (!credential) return { status: 404, error: 'Credential not found' }
    queries.deleteCredential(ctx.db, id)
    eventBus.emit(`room:${credential.roomId}`, 'credential:deleted', { id })
    return { data: { ok: true } }
  })
}
