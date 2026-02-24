import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestServer, request, requestAsUser, requestNoAuth, type TestContext } from './helpers/test-server'
import { updateRoom, listRooms, listClerkMessages, listChatMessages } from '../../shared/db-queries'
import { createRoom as createRoomFull } from '../../shared/room'
import { eventBus, type WsEvent } from '../event-bus'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Server integration', () => {
  describe('Auth', () => {
    it('GET /api/auth/handshake returns user token (not agent token)', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/handshake')
      expect(res.status).toBe(200)
      expect((res.body as any).token).toBe(ctx.userToken)
      expect((res.body as any).token).not.toBe(ctx.token)
    })

    it('GET /api/auth/handshake rejects non-local origins', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/handshake', {
        Origin: 'https://app.quoroom.ai'
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/auth/verify succeeds with agent token', async () => {
      const res = await request(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
      expect((res.body as any).role).toBe('agent')
      expect((res.body as any).profile).toBeNull()
    })

    it('GET /api/auth/verify succeeds with user token', async () => {
      const res = await requestAsUser(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
      expect((res.body as any).role).toBe('user')
      expect((res.body as any).profile).toBeNull()
    })

    it('GET /api/auth/verify fails without token', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/auth/verify')
      expect(res.status).toBe(401)
    })

    it('rejects unauthenticated API requests', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(401)
    })

    it('rejects query-token auth on non-download API routes', async () => {
      const res = await requestNoAuth(ctx, 'GET', `/api/rooms?token=${ctx.token}`)
      expect(res.status).toBe(401)
    })
  })

  describe('Role-based access (auto mode)', () => {
    it('agent can create resources in auto mode', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { name: 'testroom' })
      expect(res.status).toBe(201)
    })

    it('user can read resources in auto mode', async () => {
      const res = await requestAsUser(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(200)
    })

    it('user cannot create tasks in auto mode', async () => {
      const res = await requestAsUser(ctx, 'POST', '/api/tasks', {
        prompt: 'test task',
        cronExpression: null
      })
      expect(res.status).toBe(403)
    })

    it('user can change settings in auto mode', async () => {
      const res = await requestAsUser(ctx, 'PUT', '/api/settings/test_key', { value: 'test_value' })
      expect(res.status).toBe(200)
    })
  })

  describe('Role-based access (semi mode)', () => {
    it('user can create tasks in semi mode', async () => {
      // Create a room in semi mode
      const result = createRoomFull(ctx.db, { name: 'Semi Test Room' })
      updateRoom(ctx.db, result.room.id, { autonomyMode: 'semi' })

      const res = await requestAsUser(ctx, 'POST', '/api/tasks', {
        prompt: 'semi test task',
        cronExpression: null,
        roomId: result.room.id
      })
      expect(res.status).toBe(201)

      // Switch back to auto for other tests
      updateRoom(ctx.db, result.room.id, { autonomyMode: 'auto' })
    })
  })

  describe('404 handling', () => {
    it('returns 404 for unknown API routes', async () => {
      const res = await request(ctx, 'GET', '/api/nonexistent')
      expect(res.status).toBe(404)
    })

    it('returns 404 for non-API routes', async () => {
      const res = await requestNoAuth(ctx, 'GET', '/something')
      expect(res.status).toBe(404)
    })
  })

  describe('CORS preflight', () => {
    it('handles OPTIONS requests', async () => {
      const res = await requestNoAuth(ctx, 'OPTIONS', '/api/rooms')
      expect(res.status).toBe(204)
    })
  })

  describe('Clerk contact ingest', () => {
    it('routes clerk inbox messages into unified clerk log and skips room chat', async () => {
      const prevDataDir = process.env.QUOROOM_DATA_DIR
      const dataDir = mkdtempSync(join(tmpdir(), 'quoroom-clerk-contact-'))
      process.env.QUOROOM_DATA_DIR = dataDir

      const created = createRoomFull(ctx.db, { name: 'clerkcontact' })
      const { getRoomCloudId } = await import('../../shared/cloud-sync')
      const { pollQueenInbox } = await import('../routes/contacts')
      const cloudRoomId = getRoomCloudId(created.room.id)
      writeFileSync(
        join(dataDir, 'cloud-room-tokens.json'),
        JSON.stringify({ rooms: { [cloudRoomId]: 'token-1' } }) + '\n'
      )

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const href = String(url)
        if (href.endsWith('/contacts/queen-message')) {
          const payload = JSON.parse(String(init?.body || '{}'))
          expect(payload.queenNickname).toBe('clerk')
          expect(payload.channels).toEqual(['email'])
          return {
            ok: true,
            json: async () => ({ ok: true, email: 'sent' }),
            text: async () => '',
          } as Response
        }
        if (href.endsWith('/contacts/queen-inbox/ack')) {
          const payload = JSON.parse(String(init?.body || '{}'))
          expect(payload.messageIds).toEqual([901])
          return {
            ok: true,
            json: async () => ({ ok: true }),
            text: async () => '',
          } as Response
        }
        if (href.includes(`/contacts/queen-inbox/${cloudRoomId}`)) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              messages: [
                {
                  id: 901,
                  queenNickname: 'clerk',
                  channel: 'email',
                  senderIdentifier: 'keeper@example.com',
                  body: 'Please remind me about metrics tomorrow.',
                  receivedAt: '2026-02-24T11:00:00.000Z',
                },
              ],
            }),
            text: async () => '',
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ ok: true, messages: [] }),
          text: async () => '',
        } as Response
      })

      vi.stubGlobal('fetch', fetchMock)
      const clerkEvents: Array<{ role: string; source: string | null; content: string }> = []
      const unsubscribe = eventBus.on('clerk', (event: WsEvent) => {
        if (event.type !== 'clerk:message') return
        const payload = event.data as { message?: { role?: string; source?: string | null; content?: string } }
        const message = payload.message
        if (!message?.role || typeof message.content !== 'string') return
        clerkEvents.push({
          role: message.role,
          source: message.source ?? null,
          content: message.content
        })
      })
      try {
        await pollQueenInbox(ctx.db, {
          runClerkTurn: async () => ({
            ok: true,
            statusCode: 200,
            response: 'Confirmed. I will remind you about metrics tomorrow.',
            error: null,
          }),
        })

        const clerkLog = listClerkMessages(ctx.db)
        const inbound = clerkLog.find((entry) =>
          entry.role === 'user'
          && entry.source === 'email'
          && entry.content.includes('metrics tomorrow')
        )
        expect(inbound).toBeTruthy()

        const outbound = clerkLog.find((entry) =>
          entry.role === 'assistant'
          && entry.source === 'email'
          && entry.content.includes('Confirmed. I will remind you about metrics tomorrow.')
        )
        expect(outbound).toBeTruthy()

        expect(listChatMessages(ctx.db, created.room.id)).toHaveLength(0)
        expect(clerkEvents.some((event) =>
          event.role === 'user'
          && event.source === 'email'
          && event.content.includes('metrics tomorrow')
        )).toBe(true)
        expect(clerkEvents.some((event) =>
          event.role === 'assistant'
          && event.source === 'email'
          && event.content.includes('Confirmed. I will remind you about metrics tomorrow.')
        )).toBe(true)
      } finally {
        unsubscribe()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        if (prevDataDir == null) delete process.env.QUOROOM_DATA_DIR
        else process.env.QUOROOM_DATA_DIR = prevDataDir
        rmSync(dataDir, { recursive: true, force: true })
      }
    })

    it('sends telegram typing while clerk prepares telegram reply', async () => {
      const prevDataDir = process.env.QUOROOM_DATA_DIR
      const dataDir = mkdtempSync(join(tmpdir(), 'quoroom-clerk-typing-'))
      process.env.QUOROOM_DATA_DIR = dataDir

      const created = createRoomFull(ctx.db, { name: 'clerktyping' })
      const { getRoomCloudId } = await import('../../shared/cloud-sync')
      const { pollQueenInbox } = await import('../routes/contacts')
      const cloudRoomId = getRoomCloudId(created.room.id)
      writeFileSync(
        join(dataDir, 'cloud-room-tokens.json'),
        JSON.stringify({ rooms: { [cloudRoomId]: 'token-typing' } }) + '\n'
      )

      let typingCalls = 0
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const href = String(url)
        if (href.endsWith('/contacts/queen-typing')) {
          typingCalls += 1
          const payload = JSON.parse(String(init?.body || '{}'))
          expect(payload.roomId).toBe(cloudRoomId)
          expect(payload.channel).toBe('telegram')
          return {
            ok: true,
            json: async () => ({ ok: true, telegram: 'sent' }),
            text: async () => '',
          } as Response
        }
        if (href.endsWith('/contacts/queen-message')) {
          const payload = JSON.parse(String(init?.body || '{}'))
          expect(payload.queenNickname).toBe('clerk')
          expect(payload.channels).toEqual(['telegram'])
          return {
            ok: true,
            json: async () => ({ ok: true, telegram: 'sent' }),
            text: async () => '',
          } as Response
        }
        if (href.endsWith('/contacts/queen-inbox/ack')) {
          return {
            ok: true,
            json: async () => ({ ok: true }),
            text: async () => '',
          } as Response
        }
        if (href.includes(`/contacts/queen-inbox/${cloudRoomId}`)) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              messages: [
                {
                  id: 1901,
                  queenNickname: 'clerk',
                  channel: 'telegram',
                  senderIdentifier: '@keeper_tg',
                  body: 'Send me today status.',
                  receivedAt: '2026-02-24T11:05:00.000Z',
                },
              ],
            }),
            text: async () => '',
          } as Response
        }
        if (href.endsWith('/rooms/register')) {
          return {
            ok: true,
            json: async () => ({ roomToken: 'token-typing' }),
            text: async () => '',
          } as Response
        }
        return {
          ok: true,
          json: async () => ({ ok: true, messages: [] }),
          text: async () => '',
        } as Response
      })

      vi.stubGlobal('fetch', fetchMock)
      try {
        const { ensureCloudRoomToken } = await import('../../shared/cloud-sync')
        await ensureCloudRoomToken({
          roomId: cloudRoomId,
          name: created.room.name,
          goal: created.room.goal ?? null,
          visibility: created.room.visibility,
          referredByCode: created.room.referredByCode,
          keeperReferralCode: null,
        })

        await pollQueenInbox(ctx.db, {
          runClerkTurn: async () => {
            await new Promise((resolve) => setTimeout(resolve, 15))
            return {
              ok: true,
              statusCode: 200,
              response: 'Status sent. I also prepared your next actions.',
              error: null,
            }
          },
        })

        expect(typingCalls).toBeGreaterThan(0)
      } finally {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        if (prevDataDir == null) delete process.env.QUOROOM_DATA_DIR
        else process.env.QUOROOM_DATA_DIR = prevDataDir
        rmSync(dataDir, { recursive: true, force: true })
      }
    })
  })
})
