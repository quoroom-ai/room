import type { Router } from '../router'
import { eventBus } from '../event-bus'
import * as queries from '../../shared/db-queries'
import {
  applyLocalModelToAll,
  cancelLocalModelInstallSession,
  getLatestLocalModelInstallSession,
  getLocalModelStatus,
  startLocalModelInstallSession,
} from '../local-model'

function emitLocalModelUpdated(action: string, extra: Record<string, unknown> = {}): void {
  eventBus.emit('local-model', 'local_model:updated', {
    action,
    ...extra,
    updatedAt: new Date().toISOString(),
  })
}

export function registerLocalModelRoutes(router: Router): void {
  router.get('/api/local-model/status', (_ctx) => {
    const status = getLocalModelStatus()
    return { data: status }
  })

  router.post('/api/local-model/install', (_ctx) => {
    const status = getLocalModelStatus()
    if (status.blockers.length > 0) {
      return {
        status: 400,
        error: `Local model install blocked: ${status.blockers.join(' ')}`,
      }
    }

    const { session, reused } = startLocalModelInstallSession()
    emitLocalModelUpdated(reused ? 'install_reused' : 'install_started', {
      sessionId: session.sessionId,
    })

    return {
      data: {
        ok: true,
        status: 'pending' as const,
        reused,
        session,
        channel: `local-model-install:${session.sessionId}`,
      },
    }
  })

  router.get('/api/local-model/install-session', (_ctx) => {
    return { data: { session: getLatestLocalModelInstallSession() } }
  })

  router.post('/api/local-model/install-sessions/:sessionId/cancel', (ctx) => {
    const sessionId = String(ctx.params.sessionId || '').trim()
    if (!sessionId) return { status: 400, error: 'sessionId is required' }
    const session = cancelLocalModelInstallSession(sessionId)
    if (!session) return { status: 404, error: 'Session not found' }
    emitLocalModelUpdated('install_canceled', { sessionId: session.sessionId })
    return { data: { ok: true, session } }
  })

  router.post('/api/local-model/apply-all', (ctx) => {
    const status = getLocalModelStatus()
    if (status.blockers.length > 0) {
      return {
        status: 400,
        error: `Local model apply blocked: ${status.blockers.join(' ')}`,
      }
    }
    if (!status.runtime.ready) {
      return {
        status: 400,
        error: 'Local model is not ready yet. Install Ollama, start daemon, and pull qwen3-coder:30b first.',
      }
    }

    try {
      const result = applyLocalModelToAll(ctx.db)
      for (const roomResult of result.rooms) {
        const updatedRoom = queries.getRoom(ctx.db, roomResult.roomId)
        if (updatedRoom) {
          eventBus.emit(`room:${roomResult.roomId}`, 'room:updated', updatedRoom)
        }
      }
      emitLocalModelUpdated('apply_all_completed', {
        model: result.modelId,
        roomCount: result.activeRoomsUpdated,
      })
      eventBus.emit('providers', 'providers:updated', {
        provider: 'ollama_local',
        action: 'apply_all_completed',
        model: result.modelId,
        roomCount: result.activeRoomsUpdated,
        updatedAt: new Date().toISOString(),
      })
      return { data: result }
    } catch (err) {
      return {
        status: 400,
        error: err instanceof Error ? err.message : 'Failed to apply local model',
      }
    }
  })
}
