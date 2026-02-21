import type { Router } from '../router'
import { getSetting, setSetting } from '../../shared/db-queries'
import {
  startProviderAuthSession,
  getProviderAuthSession,
  getLatestProviderAuthSession,
  cancelProviderAuthSession,
  type ProviderName,
} from '../provider-auth'
import {
  cancelProviderInstallSession,
  getLatestProviderInstallSession,
  getProviderInstallSession,
  startProviderInstallSession,
} from '../provider-install'
import {
  disconnectProvider,
  probeProviderConnected,
  probeProviderInstalled,
} from '../provider-cli'

const PROVIDERS: ProviderName[] = ['codex', 'claude']

function isProvider(value: string): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName)
}

export function registerProviderRoutes(router: Router): void {
  router.get('/api/providers/status', async (ctx) => {
    const codexInstalled = probeProviderInstalled('codex')
    const claudeInstalled = probeProviderInstalled('claude')
    const codexConnected = probeProviderConnected('codex')
    const claudeConnected = probeProviderConnected('claude')

    return {
      data: {
        codex: {
          ...codexInstalled,
          connected: codexConnected,
          requestedAt: getSetting(ctx.db, 'provider_codex_connect_requested_at'),
          disconnectedAt: getSetting(ctx.db, 'provider_codex_disconnected_at'),
          authSession: getLatestProviderAuthSession('codex'),
          installRequestedAt: getSetting(ctx.db, 'provider_codex_install_requested_at'),
          installSession: getLatestProviderInstallSession('codex'),
        },
        claude: {
          ...claudeInstalled,
          connected: claudeConnected,
          requestedAt: getSetting(ctx.db, 'provider_claude_connect_requested_at'),
          disconnectedAt: getSetting(ctx.db, 'provider_claude_disconnected_at'),
          authSession: getLatestProviderAuthSession('claude'),
          installRequestedAt: getSetting(ctx.db, 'provider_claude_install_requested_at'),
          installSession: getLatestProviderInstallSession('claude'),
        },
      },
    }
  })

  router.post('/api/providers/:provider/connect', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    const installed = probeProviderInstalled(provider)
    if (!installed.installed) {
      return { status: 400, error: `${provider} CLI is not installed` }
    }

    const requestedAt = new Date().toISOString()
    setSetting(ctx.db, `provider_${provider}_connect_requested_at`, requestedAt)

    const { session, reused } = startProviderAuthSession(provider)
    return {
      data: {
        ok: true,
        provider,
        status: 'pending',
        requestedAt,
        reused,
        session,
        channel: `provider-auth:${session.sessionId}`,
      },
    }
  })

  router.post('/api/providers/:provider/install', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    const installed = probeProviderInstalled(provider)
    if (installed.installed) {
      return {
        data: {
          ok: true,
          provider,
          status: 'already_installed' as const,
          installed,
          session: getLatestProviderInstallSession(provider),
        },
      }
    }

    const requestedAt = new Date().toISOString()
    setSetting(ctx.db, `provider_${provider}_install_requested_at`, requestedAt)

    const { session, reused } = startProviderInstallSession(provider)
    return {
      data: {
        ok: true,
        provider,
        status: 'pending' as const,
        requestedAt,
        reused,
        session,
        channel: `provider-install:${session.sessionId}`,
      },
    }
  })

  router.post('/api/providers/:provider/disconnect', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    const latest = getLatestProviderAuthSession(provider)
    if (latest?.active) cancelProviderAuthSession(latest.sessionId)

    const disconnected = disconnectProvider(provider)
    const disconnectedAt = new Date().toISOString()
    setSetting(ctx.db, `provider_${provider}_disconnected_at`, disconnectedAt)

    return {
      data: {
        ok: true,
        provider,
        status: 'disconnected',
        disconnectedAt,
        command: disconnected.command,
        commandResult: disconnected.result.ok ? 'ok' : 'unknown',
      },
    }
  })

  router.get('/api/providers/:provider/session', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    return { data: { session: getLatestProviderAuthSession(provider) } }
  })

  router.get('/api/providers/:provider/install-session', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }
    return { data: { session: getLatestProviderInstallSession(provider) } }
  })

  router.get('/api/providers/sessions/:sessionId', async (ctx) => {
    const sessionId = String(ctx.params.sessionId || '').trim()
    if (!sessionId) return { status: 400, error: 'sessionId is required' }
    const session = getProviderAuthSession(sessionId)
    if (!session) return { status: 404, error: 'Session not found' }
    return { data: { session } }
  })

  router.post('/api/providers/sessions/:sessionId/cancel', async (ctx) => {
    const sessionId = String(ctx.params.sessionId || '').trim()
    if (!sessionId) return { status: 400, error: 'sessionId is required' }
    const session = cancelProviderAuthSession(sessionId)
    if (!session) return { status: 404, error: 'Session not found' }
    return { data: { ok: true, session } }
  })

  router.get('/api/providers/install-sessions/:sessionId', async (ctx) => {
    const sessionId = String(ctx.params.sessionId || '').trim()
    if (!sessionId) return { status: 400, error: 'sessionId is required' }
    const session = getProviderInstallSession(sessionId)
    if (!session) return { status: 404, error: 'Session not found' }
    return { data: { session } }
  })

  router.post('/api/providers/install-sessions/:sessionId/cancel', async (ctx) => {
    const sessionId = String(ctx.params.sessionId || '').trim()
    if (!sessionId) return { status: 400, error: 'sessionId is required' }
    const session = cancelProviderInstallSession(sessionId)
    if (!session) return { status: 404, error: 'Session not found' }
    return { data: { ok: true, session } }
  })
}
