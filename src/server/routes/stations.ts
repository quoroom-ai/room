import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerStationRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/stations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    return { data: queries.listStations(ctx.db, roomId) }
  })

  router.get('/api/stations/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const station = queries.getStation(ctx.db, id)
    if (!station) return { status: 404, error: 'Station not found' }
    return { data: station }
  })

  router.post('/api/rooms/:roomId/stations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.name || typeof body.name !== 'string') {
      return { status: 400, error: 'name is required' }
    }
    if (!body.provider || typeof body.provider !== 'string') {
      return { status: 400, error: 'provider is required' }
    }
    if (!body.tier || typeof body.tier !== 'string') {
      return { status: 400, error: 'tier is required' }
    }

    const station = queries.createStation(ctx.db, roomId, body.name, body.provider, body.tier, {
      region: body.region as string | undefined,
      config: body.config as Record<string, unknown> | undefined
    })
    eventBus.emit(`room:${roomId}`, 'station:created', station)
    return { status: 201, data: station }
  })

  router.patch('/api/stations/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const station = queries.getStation(ctx.db, id)
    if (!station) return { status: 404, error: 'Station not found' }
    const body = ctx.body as Record<string, unknown> || {}
    const updated = queries.updateStation(ctx.db, id, body as any)
    eventBus.emit(`room:${station.roomId}`, 'station:updated', updated)
    return { data: updated }
  })

  router.delete('/api/stations/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const station = queries.getStation(ctx.db, id)
    if (!station) return { status: 404, error: 'Station not found' }
    queries.deleteStation(ctx.db, id)
    eventBus.emit(`room:${station.roomId}`, 'station:deleted', { id })
    return { data: { ok: true } }
  })
}
