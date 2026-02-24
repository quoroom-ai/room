import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import * as queries from '../../shared/db-queries'
import { createRoom as createRoomFull } from '../../shared/room'
import { getRoomCloudId } from '../../shared/cloud-sync'
import { relayPendingKeeperRequests } from '../clerk-notifications'

let db: Database.Database
let dataDir: string
let prevDataDir: string | undefined

beforeEach(() => {
  db = initTestDb()
  dataDir = mkdtempSync(join(tmpdir(), 'quoroom-clerk-digest-'))
  prevDataDir = process.env.QUOROOM_DATA_DIR
  process.env.QUOROOM_DATA_DIR = dataDir
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (prevDataDir == null) delete process.env.QUOROOM_DATA_DIR
  else process.env.QUOROOM_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
  db.close()
})

describe('relayPendingKeeperRequests', () => {
  it('sends one consolidated keeper digest and does not resend unchanged items', async () => {
    const created = createRoomFull(db, { name: 'domains' })
    const roomId = created.room.id
    const queenId = created.room.queenWorkerId ?? created.queen?.id ?? null

    queries.setSetting(db, 'keeper_user_number', '12345')
    queries.setSetting(db, 'contact_email', 'keeper@example.com')
    queries.setSetting(db, 'contact_email_verified_at', new Date().toISOString())
    queries.setSetting(db, 'clerk_notify_email', 'true')
    queries.setSetting(db, 'clerk_notify_telegram', 'false')

    const cloudRoomId = getRoomCloudId(roomId)
    writeFileSync(
      join(dataDir, 'cloud-room-tokens.json'),
      JSON.stringify({ rooms: { [cloudRoomId]: 'token-digest' } }) + '\n'
    )

    queries.createEscalation(db, roomId, queenId, 'Need your risk tolerance before continuing.')
    queries.createEscalation(db, roomId, queenId, 'Should I hard-stop or continue with mitigation plan?')
    queries.createDecision(db, roomId, queenId, 'Approve temporary freeze on new experiments?', 'strategy')
    queries.createDecision(db, roomId, queenId, 'Approve reallocating cycles to reliability?', 'strategy')
    queries.createRoomMessage(db, roomId, 'inbound', 'Partner request for updated timeline', 'Can you confirm ETA?')

    let deliveryCalls = 0
    const deliveredQuestions: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url)
      if (!href.endsWith('/contacts/queen-message')) {
        throw new Error(`Unexpected fetch URL: ${href}`)
      }
      deliveryCalls += 1
      const payload = JSON.parse(String(init?.body || '{}'))
      const question = String(payload.question ?? '')
      deliveredQuestions.push(question)
      expect(payload.queenNickname).toBe('clerk')
      expect(payload.channels).toEqual(['email'])
      expect(question).not.toContain('Hi, Clerk here.')
      expect(question).not.toContain('Guard update:')
      expect(question).toMatch(/(I need your call on|decision point|Quick sync: I have)/)
      expect(question).toMatch(/(Urgent questions|Immediate calls needed|Escalations that need your answer)/)
      expect(question).toMatch(/(Votes to confirm|Pending votes|Choices waiting for your vote)/)
      expect(question).toMatch(/(What do you think we should do next|What direction do you want me to execute|Tell me your call and I will carry it out right away)/)
      return {
        ok: true,
        json: async () => ({ ok: true, email: 'sent' }),
        text: async () => '',
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await relayPendingKeeperRequests(db)

    const clerkMessages = queries.listClerkMessages(db).filter((entry) => entry.source === 'task')
    expect(clerkMessages).toHaveLength(1)
    expect(clerkMessages[0].content).not.toContain('Hi, Clerk here.')
    expect(clerkMessages[0].content).not.toContain('Guard update:')
    expect(clerkMessages[0].content).toMatch(/(Incoming room messages|Room inbox updates|Messages from rooms waiting on you)/)
    expect(deliveryCalls).toBe(1)
    expect(queries.getSetting(db, 'clerk_notify_digest_style_cursor')).toBe('1')

    await relayPendingKeeperRequests(db)
    expect(deliveryCalls).toBe(1)
    expect(queries.listClerkMessages(db).filter((entry) => entry.source === 'task')).toHaveLength(1)

    queries.createEscalation(db, roomId, queenId, 'Need your final call on incident rollback.')
    queries.createDecision(db, roomId, queenId, 'Approve immediate rollback and pause feature work?', 'strategy')
    await relayPendingKeeperRequests(db)

    const secondRunMessages = queries.listClerkMessages(db).filter((entry) => entry.source === 'task')
    expect(secondRunMessages).toHaveLength(2)
    expect(deliveryCalls).toBe(2)
    expect(deliveredQuestions[1]).not.toEqual(deliveredQuestions[0])
    expect(queries.getSetting(db, 'clerk_notify_digest_style_cursor')).toBe('2')
  })
})
