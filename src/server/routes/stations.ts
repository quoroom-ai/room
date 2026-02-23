import type { Router } from '../router'
import { eventBus } from '../event-bus'
import * as queries from '../../shared/db-queries'
import {
  getRoomCloudId,
  ensureCloudRoomToken,
  listCloudStations,
  listCloudStationPayments,
  startCloudStation,
  stopCloudStation,
  deleteCloudStation,
  cancelCloudStation,
  getCloudCryptoPrices,
  cryptoCheckoutStation,
} from '../../shared/cloud-sync'
import { sendToken, type NetworkName } from '../../shared/wallet'
import { CHAIN_CONFIGS } from '../../shared/constants'
import { getMachineId } from '../../shared/telemetry'

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

  router.get('/api/rooms/:roomId/cloud-station-payments', async (ctx) => {
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
    const payments = await listCloudStationPayments(cloudRoomId)
    return { data: payments }
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
    eventBus.emit(`room:${roomId}`, 'station:started', { roomId, stationId })
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
    eventBus.emit(`room:${roomId}`, 'station:stopped', { roomId, stationId })
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
    eventBus.emit(`room:${roomId}`, 'station:canceled', { roomId, stationId })
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
    eventBus.emit(`room:${roomId}`, 'station:deleted', { roomId, stationId })
    return { data: { ok: true } }
  })

  // ─── Crypto station purchase ─────────────────────────────────

  router.get('/api/rooms/:roomId/cloud-stations/crypto-prices', async (ctx) => {
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
    const pricing = await getCloudCryptoPrices(cloudRoomId)
    if (!pricing) return { status: 503, error: 'Crypto pricing unavailable' }
    return { data: pricing }
  })

  router.post('/api/rooms/:roomId/cloud-stations/crypto-checkout', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    const { tier, name, chain, token } = ctx.body as {
      tier: string; name: string
      chain?: string; token?: string
    }
    if (!tier || !name) {
      return { status: 400, error: 'Missing required fields: tier, name' }
    }
    const encryptionKey = getMachineId()

    const selectedChain = (chain ?? 'base') as NetworkName
    const selectedToken = token ?? 'usdc'

    const chainConfig = CHAIN_CONFIGS[selectedChain]
    if (!chainConfig) return { status: 400, error: `Unsupported chain: ${selectedChain}` }
    const tokenConfig = chainConfig.tokens[selectedToken]
    if (!tokenConfig) return { status: 400, error: `Token ${selectedToken} not available on ${selectedChain}` }

    const cloudRoomId = getRoomCloudId(roomId)
    await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
    })

    // 1. Get pricing from cloud
    const pricing = await getCloudCryptoPrices(cloudRoomId)
    if (!pricing) return { status: 503, error: 'Crypto payments unavailable' }
    const tierInfo = pricing.tiers.find(t => t.tier === tier)
    if (!tierInfo) return { status: 400, error: `Unknown tier: ${tier}` }

    // 2. Send stablecoin to treasury
    let txHash: string
    try {
      txHash = await sendToken(
        ctx.db, roomId, pricing.treasuryAddress,
        tierInfo.cryptoPrice.toString(), encryptionKey,
        selectedChain, tokenConfig.address, tokenConfig.decimals
      )
    } catch (e) {
      return { status: 400, error: `Transfer failed: ${(e as Error).message}` }
    }

    // 3. Submit tx hash to cloud for verification + provisioning
    const result = await cryptoCheckoutStation(cloudRoomId, tier, name, txHash, selectedChain)
    if (!result.ok) {
      return {
        status: 502,
        error: result.error ?? 'Provisioning failed',
        data: { txHash },
      }
    }

    eventBus.emit(`room:${roomId}`, 'station:created', { roomId, tier, name })
    eventBus.emit(`room:${roomId}`, 'wallet:sent', { roomId, amount: tierInfo.cryptoPrice, to: pricing.treasuryAddress })

    return {
      data: {
        ok: true,
        txHash,
        subscriptionId: result.subscriptionId,
        currentPeriodEnd: result.currentPeriodEnd,
      },
    }
  })
}
