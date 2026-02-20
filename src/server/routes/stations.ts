import type { Router } from '../router'
import * as queries from '../../shared/db-queries'

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
}
