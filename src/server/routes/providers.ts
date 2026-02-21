import type { Router } from '../router'
import { execFileSync } from 'node:child_process'
import { getSetting, setSetting } from '../../shared/db-queries'
import {
  startProviderAuthSession,
  getProviderAuthSession,
  getLatestProviderAuthSession,
  cancelProviderAuthSession,
  type ProviderName,
} from '../provider-auth'

const PROVIDERS: ProviderName[] = ['codex', 'claude']

function isProvider(value: string): value is ProviderName {
  return PROVIDERS.includes(value as ProviderName)
}

function safeExec(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    return { ok: true, stdout, stderr: '' }
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    return {
      ok: false,
      stdout: e.stdout?.toString().trim() ?? '',
      stderr: e.stderr?.toString().trim() || e.message || '',
    }
  }
}

function probeInstalled(provider: ProviderName): { installed: boolean; version?: string } {
  const out = safeExec(provider, ['--version'])
  return out.ok ? { installed: true, version: out.stdout || undefined } : { installed: false }
}

function probeConnected(provider: ProviderName): boolean | null {
  const attempts = provider === 'codex'
    ? [['auth', 'status'], ['login', '--status']]
    : [['auth', 'status'], ['login', 'status']]
  for (const args of attempts) {
    const out = safeExec(provider, args)
    if (!out.ok) continue
    const combined = `${out.stdout}\n${out.stderr}`.toLowerCase()
    if (combined.includes('not logged') || combined.includes('logged out') || combined.includes('unauth')) return false
    return true
  }
  return null
}

function disconnectCommand(provider: ProviderName): string {
  return provider === 'codex' ? 'codex logout' : 'claude logout'
}

export function registerProviderRoutes(router: Router): void {
  router.get('/api/providers/status', async (ctx) => {
    const codexInstalled = probeInstalled('codex')
    const claudeInstalled = probeInstalled('claude')
    const codexConnected = probeConnected('codex')
    const claudeConnected = probeConnected('claude')

    return {
      data: {
        codex: {
          ...codexInstalled,
          connected: codexConnected,
          requestedAt: getSetting(ctx.db, 'provider_codex_connect_requested_at'),
          disconnectedAt: getSetting(ctx.db, 'provider_codex_disconnected_at'),
          authSession: getLatestProviderAuthSession('codex'),
        },
        claude: {
          ...claudeInstalled,
          connected: claudeConnected,
          requestedAt: getSetting(ctx.db, 'provider_claude_connect_requested_at'),
          disconnectedAt: getSetting(ctx.db, 'provider_claude_disconnected_at'),
          authSession: getLatestProviderAuthSession('claude'),
        },
      },
    }
  })

  router.post('/api/providers/:provider/connect', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    const installed = probeInstalled(provider)
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

  router.post('/api/providers/:provider/disconnect', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    const latest = getLatestProviderAuthSession(provider)
    if (latest?.active) cancelProviderAuthSession(latest.sessionId)

    const out = safeExec(provider, disconnectCommand(provider).split(' ').slice(1))
    const disconnectedAt = new Date().toISOString()
    setSetting(ctx.db, `provider_${provider}_disconnected_at`, disconnectedAt)

    return {
      data: {
        ok: true,
        provider,
        status: 'disconnected',
        disconnectedAt,
        command: disconnectCommand(provider),
        commandResult: out.ok ? 'ok' : 'unknown',
      },
    }
  })

  router.get('/api/providers/:provider/session', async (ctx) => {
    const provider = String(ctx.params.provider || '').toLowerCase()
    if (!isProvider(provider)) return { status: 400, error: 'provider must be codex or claude' }

    return { data: { session: getLatestProviderAuthSession(provider) } }
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
}
