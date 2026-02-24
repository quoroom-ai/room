import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

beforeEach(() => {
  vi.restoreAllMocks()
  process.env.RESEND_API_KEY = 'test-key'
  ctx.db.prepare("DELETE FROM settings WHERE key LIKE 'contact_%'").run()
})

describe('Contact routes', () => {
  it('starts email verification and verifies with code', async () => {
    let sentCode = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/rooms/register')) {
        return jsonResponse({ roomToken: 'test-room-token' })
      }
      if (url.includes('/contacts/email/send-code/')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { code?: string }
        sentCode = payload.code ?? ''
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ ok: true })
    })

    const start = await request(ctx, 'POST', '/api/contacts/email/start', { email: 'keeper@example.com' })
    expect(start.status).toBe(200)
    expect((start.body as { sentTo?: string }).sentTo).toBe('keeper@example.com')
    expect(sentCode).toMatch(/^\d{6}$/)

    const verify = await request(ctx, 'POST', '/api/contacts/email/verify', { code: sentCode })
    expect(verify.status).toBe(200)
    expect((verify.body as { email: string }).email).toBe('keeper@example.com')

    const status = await request(ctx, 'GET', '/api/contacts/status')
    expect(status.status).toBe(200)
    expect((status.body as { email: { verified: boolean } }).email.verified).toBe(true)
  })

  it('enforces resend cooldown for email verification', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/rooms/register')) return jsonResponse({ roomToken: 'test-room-token' })
      return jsonResponse({ ok: true })
    })

    const first = await request(ctx, 'POST', '/api/contacts/email/start', { email: 'cooldown@example.com' })
    expect(first.status).toBe(200)

    const resend = await request(ctx, 'POST', '/api/contacts/email/resend')
    expect(resend.status).toBe(429)
  })

  it('verifies telegram via cloud bridge token status', async () => {
    let pendingTokenHash = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/telegram/verify/start')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { tokenHash?: string }
        pendingTokenHash = payload.tokenHash ?? ''
        return jsonResponse({ ok: true, botUsername: 'quoroom_ai_bot' })
      }
      if (url.endsWith(`/telegram/verify/status/${encodeURIComponent(pendingTokenHash)}`)) {
        return jsonResponse({
          ok: true,
          status: 'verified',
          botUsername: 'quoroom_ai_bot',
          telegram: {
            id: '123456',
            username: 'keeper_tg',
            firstName: 'Keeper',
            verifiedAt: new Date().toISOString(),
          },
        })
      }
      return jsonResponse({ ok: true })
    })

    const start = await request(ctx, 'POST', '/api/contacts/telegram/start')
    expect(start.status).toBe(200)
    expect((start.body as { deepLink?: string }).deepLink).toContain('https://t.me/quoroom_ai_bot?start=tv1_')
    expect(pendingTokenHash).toMatch(/^[a-f0-9]{64}$/)

    const check = await request(ctx, 'POST', '/api/contacts/telegram/check')
    expect(check.status).toBe(200)
    expect((check.body as { status?: string }).status).toBe('verified')

    const status = await request(ctx, 'GET', '/api/contacts/status')
    expect(status.status).toBe(200)
    expect((status.body as { telegram: { verified: boolean; username: string | null } }).telegram.verified).toBe(true)
    expect((status.body as { telegram: { verified: boolean; username: string | null } }).telegram.username).toBe('keeper_tg')
  })
})
