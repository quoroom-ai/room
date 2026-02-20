import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import {
  getRoomCloudId,
  ensureCloudRoomToken,
  listCloudStations,
  startCloudStation,
  stopCloudStation,
  deleteCloudStation,
  cancelCloudStation,
} from '../../shared/cloud-sync'

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

  router.get('/api/rooms/:roomId/cloud-stations', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })
    const stations = await listCloudStations(cloudRoomId)
    return { data: stations }
  })

  router.post('/api/rooms/:roomId/cloud-stations/:id/start', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const stationId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })
    await startCloudStation(cloudRoomId, stationId)
    return { data: { ok: true } }
  })

  router.post('/api/rooms/:roomId/cloud-stations/:id/stop', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const stationId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })
    await stopCloudStation(cloudRoomId, stationId)
    return { data: { ok: true } }
  })

  router.post('/api/rooms/:roomId/cloud-stations/:id/cancel', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const stationId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })
    await cancelCloudStation(cloudRoomId, stationId)
    return { data: { ok: true } }
  })

  router.delete('/api/rooms/:roomId/cloud-stations/:id', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const stationId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })
    await deleteCloudStation(cloudRoomId, stationId)
    return { data: { ok: true } }
  })
}
