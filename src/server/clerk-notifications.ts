import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { isCloudDeployment } from './auth'
import { ensureCloudRoomToken, getRoomCloudId, getStoredCloudRoomToken } from '../shared/cloud-sync'
import type { Room } from '../shared/types'
import { insertClerkMessageAndEmit } from './clerk-message-events'

export type ClerkNotifyChannel = 'email' | 'telegram'

export const CLERK_NOTIFY_EMAIL_KEY = 'clerk_notify_email'
export const CLERK_NOTIFY_TELEGRAM_KEY = 'clerk_notify_telegram'
export const CLERK_NOTIFY_MIN_INTERVAL_MINUTES_KEY = 'clerk_notify_min_interval_minutes'
export const CLERK_NOTIFY_URGENT_MIN_INTERVAL_MINUTES_KEY = 'clerk_notify_urgent_min_interval_minutes'

const CLERK_NOTIFY_ESCALATION_CURSOR_KEY = 'clerk_notify_escalation_cursor'
const CLERK_NOTIFY_DECISION_CURSOR_KEY = 'clerk_notify_decision_cursor'
const CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY = 'clerk_notify_room_message_cursor'
const CLERK_NOTIFY_DIGEST_STYLE_CURSOR_KEY = 'clerk_notify_digest_style_cursor'
const CLERK_NOTIFY_LAST_SENT_AT_KEY = 'clerk_notify_last_sent_at'

const DEFAULT_NOTIFY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_NOTIFY_URGENT_MIN_INTERVAL_MS = 60 * 60 * 1000
const MIN_NOTIFY_INTERVAL_MS = 30 * 60 * 1000
const MAX_NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000
const MIN_URGENT_INTERVAL_MS = 10 * 60 * 1000
const MAX_URGENT_INTERVAL_MS = 12 * 60 * 60 * 1000
const URGENT_ESCALATION_THRESHOLD = 6
const URGENT_DECISION_THRESHOLD = 4
const URGENT_TOTAL_THRESHOLD = 12

type CountPhrase = (count: number) => string

const DIGEST_OPENERS: CountPhrase[] = [
  (count) => `I need your call on ${count} item${count === 1 ? '' : 's'}.`,
  (count) => `${count} decision point${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your direction right now.`,
  (count) => `Quick sync: I have ${count} item${count === 1 ? '' : 's'} waiting for your decision.`,
]

const ESCALATION_HEADERS: CountPhrase[] = [
  (count) => `Urgent questions (${count}):`,
  (count) => `Immediate calls needed (${count}):`,
  (count) => `Escalations that need your answer (${count}):`,
]

const DECISION_HEADERS: CountPhrase[] = [
  (count) => `Votes to confirm (${count}):`,
  (count) => `Pending votes (${count}):`,
  (count) => `Choices waiting for your vote (${count}):`,
]

const ROOM_MESSAGE_HEADERS: CountPhrase[] = [
  (count) => `Incoming room messages (${count}):`,
  (count) => `Room inbox updates (${count}):`,
  (count) => `Messages from rooms waiting on you (${count}):`,
]

const DIGEST_CLOSERS: string[] = [
  'What do you think we should do next? What are you going to do?',
  'What direction do you want me to execute?',
  'Tell me your call and I will carry it out right away.',
]

function settingEnabled(raw: string | null | undefined, defaultValue: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return defaultValue
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  return defaultValue
}

function parseCursor(raw: string | null | undefined): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function parseIsoMs(raw: string | null | undefined): number | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveIntervalMs(
  db: Database.Database,
  key: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  const raw = (queries.getSetting(db, key) ?? '').trim()
  if (!raw) return fallbackMs
  const minutes = Number.parseInt(raw, 10)
  if (!Number.isFinite(minutes) || minutes < 0) return fallbackMs
  if (minutes === 0) return 0
  return Math.min(maxMs, Math.max(minMs, minutes * 60_000))
}

function getKeeperUserNumber(db: Database.Database): number | null {
  const raw = (queries.getSetting(db, 'keeper_user_number') ?? '').trim()
  if (!/^\d{5,6}$/.test(raw)) return null
  return Number.parseInt(raw, 10)
}

async function getAnyCloudRoomAuth(db: Database.Database): Promise<{ cloudRoomId: string; roomToken: string } | null> {
  const rooms = queries.listRooms(db)
  if (rooms.length === 0) return null

  const keeperReferralCodeRaw = (queries.getSetting(db, 'keeper_referral_code') ?? '').trim()
  const keeperReferralCode = keeperReferralCodeRaw || null

  for (const room of rooms) {
    const cloudRoomId = getRoomCloudId(room.id)
    let roomToken = getStoredCloudRoomToken(cloudRoomId)
    if (!roomToken) {
      const hasToken = await ensureCloudRoomToken({
        roomId: cloudRoomId,
        name: room.name,
        goal: room.goal ?? null,
        visibility: room.visibility,
        referredByCode: room.referredByCode,
        keeperReferralCode,
      })
      if (!hasToken) continue
      roomToken = getStoredCloudRoomToken(cloudRoomId)
    }
    if (!roomToken) continue
    return { cloudRoomId, roomToken }
  }

  return null
}

function hasVerifiedEmail(db: Database.Database): boolean {
  const email = (queries.getSetting(db, 'contact_email') ?? '').trim()
  const verifiedAt = (queries.getSetting(db, 'contact_email_verified_at') ?? '').trim()
  return Boolean(email && verifiedAt)
}

function hasVerifiedTelegram(db: Database.Database): boolean {
  const telegramId = (queries.getSetting(db, 'contact_telegram_id') ?? '').trim()
  const verifiedAt = (queries.getSetting(db, 'contact_telegram_verified_at') ?? '').trim()
  return Boolean(telegramId && verifiedAt)
}

export function getClerkNotifyPreferences(db: Database.Database): { email: boolean; telegram: boolean } {
  const email = settingEnabled(queries.getSetting(db, CLERK_NOTIFY_EMAIL_KEY), true)
  const telegram = settingEnabled(queries.getSetting(db, CLERK_NOTIFY_TELEGRAM_KEY), true)
  return { email, telegram }
}

export function getClerkPreferredNotifyChannels(db: Database.Database): ClerkNotifyChannel[] {
  const prefs = getClerkNotifyPreferences(db)
  const channels: ClerkNotifyChannel[] = []
  if (prefs.email && hasVerifiedEmail(db)) channels.push('email')
  if (prefs.telegram && hasVerifiedTelegram(db)) channels.push('telegram')
  return channels
}

interface SendClerkAlertInput {
  content: string
}

async function sendClerkAlert(
  db: Database.Database,
  input: SendClerkAlertInput,
): Promise<boolean> {
  if (isCloudDeployment()) return false
  const body = input.content.trim()
  if (!body) return false

  const channels = getClerkPreferredNotifyChannels(db)
  if (channels.length === 0) return false

  const keeperUserNumber = getKeeperUserNumber(db)
  if (!keeperUserNumber) return false

  const auth = await getAnyCloudRoomAuth(db)
  if (!auth) return false

  const cloudApiBase = (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.io/api').replace(/\/+$/, '')
  const res = await fetch(`${cloudApiBase}/contacts/queen-message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': auth.roomToken,
    },
    body: JSON.stringify({
      roomId: auth.cloudRoomId,
      queenNickname: 'clerk',
      userNumber: keeperUserNumber,
      question: body,
      channels,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return false

  const payload = await res.json().catch(() => ({})) as { email?: string; telegram?: string }
  const sentEmail = channels.includes('email') ? payload.email === 'sent' : false
  const sentTelegram = channels.includes('telegram') ? payload.telegram === 'sent' : false
  const sentAny = sentEmail || sentTelegram
  if (!sentAny) return false

  insertClerkMessageAndEmit(db, 'assistant', body, 'task')
  return true
}

function clip(text: string, max: number = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3))}...`
}

function summarizeRequest(text: string, max: number = 180): string {
  const compact = clip(text, max)
  const stop = compact.search(/[.!?]\s/)
  if (stop > 24) return compact.slice(0, stop + 1)
  return compact
}

interface PendingEscalationItem {
  room: Room
  escalation: ReturnType<typeof queries.getEscalation>
}

interface PendingDecisionItem {
  room: Room
  decision: ReturnType<typeof queries.getDecision>
}

interface PendingRoomMessageItem {
  room: Room
  message: ReturnType<typeof queries.getRoomMessage>
}

interface PendingDigestCounts {
  escalations: number
  decisions: number
  roomMessages: number
  total: number
}

const DIGEST_SECTION_LIMIT = 4

function pickVariant<T>(variants: readonly T[], cursor: number, offset: number = 0): T {
  if (variants.length === 0) throw new Error('variants must not be empty')
  const index = Math.abs(cursor + offset) % variants.length
  return variants[index]
}

function buildKeeperDigest(
  db: Database.Database,
  input: {
    escalations: PendingEscalationItem[]
    decisions: PendingDecisionItem[]
    roomMessages: PendingRoomMessageItem[]
  },
  styleCursor: number,
): string {
  const total = input.escalations.length + input.decisions.length + input.roomMessages.length
  if (total === 0) return ''

  const lines: string[] = []
  lines.push(pickVariant(DIGEST_OPENERS, styleCursor)(total))

  if (input.escalations.length > 0) {
    lines.push('', pickVariant(ESCALATION_HEADERS, styleCursor, 1)(input.escalations.length))
    const visible = input.escalations.slice(0, DIGEST_SECTION_LIMIT)
    for (const item of visible) {
      if (!item.escalation) continue
      const fromName = item.escalation.fromAgentId
        ? (queries.getWorker(db, item.escalation.fromAgentId)?.name ?? `worker #${item.escalation.fromAgentId}`)
        : 'agent'
      lines.push(`- [${item.room.name} #${item.escalation.id}] ${fromName}: ${summarizeRequest(item.escalation.question, 150)}`)
    }
    const remaining = input.escalations.length - visible.length
    if (remaining > 0) lines.push(`- ...and ${remaining} more escalation${remaining === 1 ? '' : 's'}.`)
  }

  if (input.decisions.length > 0) {
    lines.push('', pickVariant(DECISION_HEADERS, styleCursor, 2)(input.decisions.length))
    const visible = input.decisions.slice(0, DIGEST_SECTION_LIMIT)
    for (const item of visible) {
      if (!item.decision) continue
      lines.push(`- [${item.room.name} decision #${item.decision.id}] ${summarizeRequest(item.decision.proposal, 150)}`)
    }
    const remaining = input.decisions.length - visible.length
    if (remaining > 0) lines.push(`- ...and ${remaining} more vote${remaining === 1 ? '' : 's'}.`)
  }

  if (input.roomMessages.length > 0) {
    lines.push('', pickVariant(ROOM_MESSAGE_HEADERS, styleCursor, 3)(input.roomMessages.length))
    const visible = input.roomMessages.slice(0, DIGEST_SECTION_LIMIT)
    for (const item of visible) {
      if (!item.message) continue
      const fromRoom = item.message.fromRoomId ?? 'unknown room'
      lines.push(`- [${item.room.name} message #${item.message.id}] from ${fromRoom}: ${summarizeRequest(item.message.subject, 140)}`)
    }
    const remaining = input.roomMessages.length - visible.length
    if (remaining > 0) lines.push(`- ...and ${remaining} more inbox item${remaining === 1 ? '' : 's'}.`)
  }

  lines.push(
    '',
    pickVariant(DIGEST_CLOSERS, styleCursor, 4)
  )

  return lines.join('\n')
}

function getPendingDigestCounts(input: {
  escalations: PendingEscalationItem[]
  decisions: PendingDecisionItem[]
  roomMessages: PendingRoomMessageItem[]
}): PendingDigestCounts {
  const escalations = input.escalations.length
  const decisions = input.decisions.length
  const roomMessages = input.roomMessages.length
  return {
    escalations,
    decisions,
    roomMessages,
    total: escalations + decisions + roomMessages,
  }
}

function isUrgentDigest(counts: PendingDigestCounts): boolean {
  return (
    counts.escalations >= URGENT_ESCALATION_THRESHOLD
    || counts.decisions >= URGENT_DECISION_THRESHOLD
    || counts.total >= URGENT_TOTAL_THRESHOLD
  )
}

export async function relayPendingKeeperRequests(db: Database.Database): Promise<void> {
  if (isCloudDeployment()) return

  const channels = getClerkPreferredNotifyChannels(db)
  if (channels.length === 0) return

  const escalationCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_ESCALATION_CURSOR_KEY))
  const decisionCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_DECISION_CURSOR_KEY))
  const roomMessageCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY))
  const digestStyleCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_DIGEST_STYLE_CURSOR_KEY))

  const pendingEscalations: PendingEscalationItem[] = []
  const pendingDecisions: PendingDecisionItem[] = []
  const pendingRoomMessages: PendingRoomMessageItem[] = []
  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    const roomEscalations = queries
      .getPendingEscalations(db, room.id)
      .filter((item) => item.toAgentId == null && item.fromAgentId != null && item.id > escalationCursor)
      .sort((a, b) => a.id - b.id)
    for (const escalation of roomEscalations) {
      pendingEscalations.push({ room, escalation })
    }

    const roomDecisions = queries
      .listDecisions(db, room.id, 'voting')
      .filter((item) => !item.keeperVote && item.id > decisionCursor)
      .sort((a, b) => a.id - b.id)
    for (const decision of roomDecisions) {
      pendingDecisions.push({ room, decision })
    }

    const unreadInbound = queries
      .listRoomMessages(db, room.id, 'unread')
      .filter((item) => item.direction === 'inbound' && item.id > roomMessageCursor)
      .sort((a, b) => a.id - b.id)
    for (const message of unreadInbound) {
      pendingRoomMessages.push({ room, message })
    }
  }

  const content = buildKeeperDigest(db, {
    escalations: pendingEscalations,
    decisions: pendingDecisions,
    roomMessages: pendingRoomMessages,
  }, digestStyleCursor)
  if (!content) return

  const pendingCounts = getPendingDigestCounts({
    escalations: pendingEscalations,
    decisions: pendingDecisions,
    roomMessages: pendingRoomMessages,
  })
  const minIntervalMs = resolveIntervalMs(
    db,
    CLERK_NOTIFY_MIN_INTERVAL_MINUTES_KEY,
    DEFAULT_NOTIFY_MIN_INTERVAL_MS,
    MIN_NOTIFY_INTERVAL_MS,
    MAX_NOTIFY_INTERVAL_MS,
  )
  const urgentIntervalMs = resolveIntervalMs(
    db,
    CLERK_NOTIFY_URGENT_MIN_INTERVAL_MINUTES_KEY,
    DEFAULT_NOTIFY_URGENT_MIN_INTERVAL_MS,
    MIN_URGENT_INTERVAL_MS,
    MAX_URGENT_INTERVAL_MS,
  )
  const lastSentMs = parseIsoMs(queries.getSetting(db, CLERK_NOTIFY_LAST_SENT_AT_KEY))
  if (lastSentMs != null) {
    const elapsedMs = Date.now() - lastSentMs
    const regularAllowed = minIntervalMs <= 0 || elapsedMs >= minIntervalMs
    const urgentAllowed = isUrgentDigest(pendingCounts) && (urgentIntervalMs <= 0 || elapsedMs >= urgentIntervalMs)
    if (!regularAllowed && !urgentAllowed) return
  }

  const sent = await sendClerkAlert(db, { content })
  if (!sent) return

  const nextEscalationCursor = pendingEscalations.reduce((max, item) =>
    Math.max(max, item.escalation?.id ?? 0), escalationCursor)
  const nextDecisionCursor = pendingDecisions.reduce((max, item) =>
    Math.max(max, item.decision?.id ?? 0), decisionCursor)
  const nextRoomMessageCursor = pendingRoomMessages.reduce((max, item) =>
    Math.max(max, item.message?.id ?? 0), roomMessageCursor)

  queries.setSetting(db, CLERK_NOTIFY_ESCALATION_CURSOR_KEY, String(nextEscalationCursor))
  queries.setSetting(db, CLERK_NOTIFY_DECISION_CURSOR_KEY, String(nextDecisionCursor))
  queries.setSetting(db, CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY, String(nextRoomMessageCursor))
  queries.setSetting(db, CLERK_NOTIFY_DIGEST_STYLE_CURSOR_KEY, String(digestStyleCursor + 1))
  queries.setSetting(db, CLERK_NOTIFY_LAST_SENT_AT_KEY, new Date().toISOString())

  const byRoom = new Map<number, { room: Room; escalations: number; decisions: number; roomMessages: number }>()
  for (const item of pendingEscalations) {
    if (!item.escalation) continue
    const summary = byRoom.get(item.room.id) ?? { room: item.room, escalations: 0, decisions: 0, roomMessages: 0 }
    summary.escalations += 1
    byRoom.set(item.room.id, summary)
  }
  for (const item of pendingDecisions) {
    if (!item.decision) continue
    const summary = byRoom.get(item.room.id) ?? { room: item.room, escalations: 0, decisions: 0, roomMessages: 0 }
    summary.decisions += 1
    byRoom.set(item.room.id, summary)
  }
  for (const item of pendingRoomMessages) {
    if (!item.message) continue
    const summary = byRoom.get(item.room.id) ?? { room: item.room, escalations: 0, decisions: 0, roomMessages: 0 }
    summary.roomMessages += 1
    byRoom.set(item.room.id, summary)
  }

  for (const summary of byRoom.values()) {
    const details: string[] = []
    if (summary.escalations > 0) details.push(`${summary.escalations} escalation${summary.escalations === 1 ? '' : 's'}`)
    if (summary.decisions > 0) details.push(`${summary.decisions} vote${summary.decisions === 1 ? '' : 's'}`)
    if (summary.roomMessages > 0) details.push(`${summary.roomMessages} inbox item${summary.roomMessages === 1 ? '' : 's'}`)
    queries.logRoomActivity(
      db,
      summary.room.id,
      'system',
      'Clerk sent keeper digest',
      details.join(', ')
    )
  }
}
