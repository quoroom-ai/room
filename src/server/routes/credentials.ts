import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

function maskCredential<T extends { valueEncrypted: string }>(credential: T): T {
  return { ...credential, valueEncrypted: '***' }
}

const VALIDATION_TIMEOUT_MS = 8000
const SUPPORTED_CREDENTIALS = new Set(['openai_api_key', 'anthropic_api_key'])

function extractApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) return record.message
  if (typeof record.error === 'string' && record.error.trim()) return record.error
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message
    if (typeof nested.type === 'string' && nested.type.trim()) return nested.type
  }
  return null
}

async function validateOpenAiKey(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/models?limit=1', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${value}`
      },
      signal: controller.signal
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    const message = extractApiError(body) || `HTTP ${res.status}`
    return { ok: false, error: `OpenAI key validation failed: ${message}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `OpenAI key validation failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

async function validateAnthropicKey(value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': value,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    const message = extractApiError(body) || `HTTP ${res.status}`
    return { ok: false, error: `Anthropic key validation failed: ${message}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Anthropic key validation failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
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

  router.post('/api/rooms/:roomId/credentials/validate', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    const body = ctx.body as Record<string, unknown> || {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const value = typeof body.value === 'string' ? body.value.trim() : ''
    if (!name) return { status: 400, error: 'name is required' }
    if (!value) return { status: 400, error: 'value is required' }
    if (!SUPPORTED_CREDENTIALS.has(name)) {
      return { status: 400, error: `Validation not supported for credential: ${name}` }
    }

    const result = name === 'openai_api_key'
      ? await validateOpenAiKey(value)
      : await validateAnthropicKey(value)
    if (!result.ok) return { status: 400, error: result.error }
    return { data: { ok: true } }
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
