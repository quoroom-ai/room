import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerMemoryRoutes(router: Router): void {
  router.post('/api/memory/entities', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.name || typeof body.name !== 'string') {
      return { status: 400, error: 'name is required' }
    }

    const entity = queries.createEntity(ctx.db, body.name,
      body.type as string | undefined,
      body.category as string | undefined,
      body.roomId as number | undefined)
    eventBus.emit('memory', 'entity:created', entity)
    return { status: 201, data: entity }
  })

  router.get('/api/memory/entities', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    const entities = queries.listEntities(ctx.db, roomId, ctx.query.category)
    return { data: entities }
  })

  router.get('/api/memory/entities/:id', (ctx) => {
    const entity = queries.getEntity(ctx.db, Number(ctx.params.id))
    if (!entity) return { status: 404, error: 'Entity not found' }
    return { data: entity }
  })

  router.patch('/api/memory/entities/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const entity = queries.getEntity(ctx.db, id)
    if (!entity) return { status: 404, error: 'Entity not found' }

    const body = ctx.body as Record<string, unknown> || {}
    queries.updateEntity(ctx.db, id, body)
    const updated = queries.getEntity(ctx.db, id)
    eventBus.emit('memory', 'entity:updated', updated)
    return { data: updated }
  })

  router.delete('/api/memory/entities/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const entity = queries.getEntity(ctx.db, id)
    if (!entity) return { status: 404, error: 'Entity not found' }

    queries.deleteEntity(ctx.db, id)
    eventBus.emit('memory', 'entity:deleted', { id })
    return { data: { ok: true } }
  })

  router.get('/api/memory/search', (ctx) => {
    const q = ctx.query.q
    if (!q) return { status: 400, error: 'q query parameter is required' }
    const results = queries.searchEntities(ctx.db, q)
    return { data: results }
  })

  router.get('/api/memory/stats', (ctx) => {
    const stats = queries.getMemoryStats(ctx.db)
    return { data: stats }
  })

  // Observations
  router.post('/api/memory/entities/:entityId/observations', (ctx) => {
    const entityId = Number(ctx.params.entityId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.content || typeof body.content !== 'string') {
      return { status: 400, error: 'content is required' }
    }

    const observation = queries.addObservation(ctx.db, entityId,
      body.content,
      body.source as string | undefined)
    eventBus.emit('memory', 'observation:added', observation)
    return { status: 201, data: observation }
  })

  router.get('/api/memory/entities/:entityId/observations', (ctx) => {
    const observations = queries.getObservations(ctx.db, Number(ctx.params.entityId))
    return { data: observations }
  })

  router.delete('/api/memory/observations/:id', (ctx) => {
    queries.deleteObservation(ctx.db, Number(ctx.params.id))
    return { data: { ok: true } }
  })

  // Relations
  router.post('/api/memory/relations', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.fromEntityId || typeof body.fromEntityId !== 'number') {
      return { status: 400, error: 'fromEntityId is required' }
    }
    if (!body.toEntityId || typeof body.toEntityId !== 'number') {
      return { status: 400, error: 'toEntityId is required' }
    }
    if (!body.relationType || typeof body.relationType !== 'string') {
      return { status: 400, error: 'relationType is required' }
    }

    const relation = queries.addRelation(ctx.db,
      body.fromEntityId,
      body.toEntityId,
      body.relationType)
    return { status: 201, data: relation }
  })

  router.get('/api/memory/entities/:entityId/relations', (ctx) => {
    const relations = queries.getRelations(ctx.db, Number(ctx.params.entityId))
    return { data: relations }
  })

  router.delete('/api/memory/relations/:id', (ctx) => {
    queries.deleteRelation(ctx.db, Number(ctx.params.id))
    return { data: { ok: true } }
  })
}
