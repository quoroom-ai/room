import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import * as queries from '../../shared/db-queries'
import { createRoom as createRoomFull } from '../../shared/room'
import { getRoomCloudId } from '../../shared/cloud-sync'
import {
  CLERK_NOTIFY_MIN_INTERVAL_MINUTES_KEY,
  CLERK_NOTIFY_URGENT_MIN_INTERVAL_MINUTES_KEY,
  relayPendingKeeperRequests,
} from '../clerk-notifications'

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
  vi.useRealTimers()
  if (prevDataDir == null) delete process.env.QUOROOM_DATA_DIR
  else process.env.QUOROOM_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
  db.close()
})

function setupNotifyDelivery(roomId: number): void {
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
}

function stubDelivery(deliveredQuestions: string[]): { getCallCount: () => number } {
  let deliveryCalls = 0
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
    return {
      ok: true,
      json: async () => ({ ok: true, email: 'sent' }),
      text: async () => '',
    } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { getCallCount: () => deliveryCalls }
}

describe('relayPendingKeeperRequests', () => {
  it('sends one consolidated keeper digest and does not resend unchanged items', async () => {
    const created = createRoomFull(db, { name: 'domains' })
    const roomId = created.room.id
    const queenId = created.room.queenWorkerId ?? created.queen?.id ?? null

    setupNotifyDelivery(roomId)
    queries.setSetting(db, CLERK_NOTIFY_MIN_INTERVAL_MINUTES_KEY, '0')
    queries.setSetting(db, CLERK_NOTIFY_URGENT_MIN_INTERVAL_MINUTES_KEY, '0')

    queries.createEscalation(db, roomId, queenId, 'Need your risk tolerance before continuing.')
    queries.createEscalation(db, roomId, queenId, 'Should I hard-stop or continue with mitigation plan?')
    queries.createDecision(db, roomId, queenId, 'Approve temporary freeze on new experiments?', 'strategy')
    queries.createDecision(db, roomId, queenId, 'Approve reallocating cycles to reliability?', 'strategy')
    queries.createRoomMessage(db, roomId, 'inbound', 'Partner request for updated timeline', 'Can you confirm ETA?')

    const deliveredQuestions: string[] = []
    const calls = stubDelivery(deliveredQuestions)

    await relayPendingKeeperRequests(db)

    const clerkMessages = queries.listClerkMessages(db).filter((entry) => entry.source === 'task')
    expect(clerkMessages).toHaveLength(1)
    expect(clerkMessages[0].content).not.toContain('Hi, Clerk here.')
    expect(clerkMessages[0].content).not.toContain('Guard update:')
    expect(clerkMessages[0].content).toMatch(/(Incoming room messages|Room inbox updates|Messages from rooms waiting on you)/)
    expect(calls.getCallCount()).toBe(1)
    expect(queries.getSetting(db, 'clerk_notify_digest_style_cursor')).toBe('1')

    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(1)
    expect(queries.listClerkMessages(db).filter((entry) => entry.source === 'task')).toHaveLength(1)

    queries.createEscalation(db, roomId, queenId, 'Need your final call on incident rollback.')
    queries.createDecision(db, roomId, queenId, 'Approve immediate rollback and pause feature work?', 'strategy')
    await relayPendingKeeperRequests(db)

    const secondRunMessages = queries.listClerkMessages(db).filter((entry) => entry.source === 'task')
    expect(secondRunMessages).toHaveLength(2)
    expect(calls.getCallCount()).toBe(2)
    expect(deliveredQuestions[1]).not.toEqual(deliveredQuestions[0])
    expect(queries.getSetting(db, 'clerk_notify_digest_style_cursor')).toBe('2')
  })

  it('batches routine requests until cooldown window elapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-25T03:00:00.000Z'))

    const created = createRoomFull(db, { name: 'ops' })
    const roomId = created.room.id
    const queenId = created.room.queenWorkerId ?? created.queen?.id ?? null
    setupNotifyDelivery(roomId)

    const deliveredQuestions: string[] = []
    const calls = stubDelivery(deliveredQuestions)

    queries.createEscalation(db, roomId, queenId, 'Need keeper decision for safe rollout window.')
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(1)

    queries.createEscalation(db, roomId, queenId, 'Need keeper sign-off on partner timeline update.')
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(1)

    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1_000)
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(2)
    expect(deliveredQuestions).toHaveLength(2)
  })

  it('allows urgent backlog to bypass regular cadence after urgent cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-25T03:00:00.000Z'))

    const created = createRoomFull(db, { name: 'finance' })
    const roomId = created.room.id
    const queenId = created.room.queenWorkerId ?? created.queen?.id ?? null
    setupNotifyDelivery(roomId)

    const deliveredQuestions: string[] = []
    const calls = stubDelivery(deliveredQuestions)

    queries.createEscalation(db, roomId, queenId, 'Need keeper decision for payout format.')
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(1)

    for (let i = 0; i < 6; i += 1) {
      queries.createEscalation(db, roomId, queenId, `Urgent issue ${i + 1}: queue keeps expanding without keeper call.`)
    }

    vi.advanceTimersByTime(30 * 60 * 1000)
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(1)

    vi.advanceTimersByTime(31 * 60 * 1000)
    await relayPendingKeeperRequests(db)
    expect(calls.getCallCount()).toBe(2)
    expect(deliveredQuestions).toHaveLength(2)
  })
})
