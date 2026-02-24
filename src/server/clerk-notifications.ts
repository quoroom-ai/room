import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { isCloudDeployment } from './auth'
import { ensureCloudRoomToken, getRoomCloudId, getStoredCloudRoomToken } from '../shared/cloud-sync'
import type { Room } from '../shared/types'
import { insertClerkMessageAndEmit } from './clerk-message-events'

export type ClerkNotifyChannel = 'email' | 'telegram'

export const CLERK_NOTIFY_EMAIL_KEY = 'clerk_notify_email'
export const CLERK_NOTIFY_TELEGRAM_KEY = 'clerk_notify_telegram'

const CLERK_NOTIFY_ESCALATION_CURSOR_KEY = 'clerk_notify_escalation_cursor'
const CLERK_NOTIFY_DECISION_CURSOR_KEY = 'clerk_notify_decision_cursor'
const CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY = 'clerk_notify_room_message_cursor'

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
  source: 'escalation' | 'decision' | 'room_message'
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

  const cloudApiBase = (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.ai/api').replace(/\/+$/, '')
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

function roomContext(room: Room): string {
  const goal = room.goal ? clip(room.goal, 120) : 'no objective set'
  return `Room "${room.name}" is ${room.status}. Objective: ${goal}.`
}

function buildEscalationAlert(db: Database.Database, room: Room, escalation: ReturnType<typeof queries.getEscalation>): string {
  if (!escalation) return ''
  const fromName = escalation.fromAgentId
    ? (queries.getWorker(db, escalation.fromAgentId)?.name ?? `worker #${escalation.fromAgentId}`)
    : 'one of the room agents'
  const summary = summarizeRequest(escalation.question, 200)
  return [
    'Hi, Clerk here.',
    `${roomContext(room)}`,
    `${fromName} needs your guidance now (escalation #${escalation.id}).`,
    `What they need: ${summary}`,
    'Reply naturally and I will deliver your instruction back to the room immediately.',
  ].join('\n')
}

function buildDecisionAlert(room: Room, decision: ReturnType<typeof queries.getDecision>): string {
  if (!decision) return ''
  const proposal = summarizeRequest(decision.proposal, 220)
  return [
    'Hi, Clerk here.',
    `${roomContext(room)}`,
    `Keeper vote is waiting (decision #${decision.id}).`,
    `Proposal summary: ${proposal}`,
    `Reply with yes/no/abstain (example: "yes on #${decision.id}") and I will cast it for you.`,
  ].join('\n')
}

function buildRoomMessageAlert(room: Room, message: ReturnType<typeof queries.getRoomMessage>): string {
  if (!message) return ''
  const subject = summarizeRequest(message.subject, 140)
  return [
    'Hi, Clerk here.',
    `${roomContext(room)}`,
    `A new inter-room message arrived (message #${message.id}) from ${message.fromRoomId ?? 'another room'}.`,
    `Topic: ${subject}`,
    'Reply with what you want me to send back and I will post it through the room inbox.',
  ].join('\n')
}

export async function relayPendingKeeperRequests(db: Database.Database): Promise<void> {
  if (isCloudDeployment()) return

  const channels = getClerkPreferredNotifyChannels(db)
  if (channels.length === 0) return

  let escalationCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_ESCALATION_CURSOR_KEY))
  let decisionCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_DECISION_CURSOR_KEY))
  let roomMessageCursor = parseCursor(queries.getSetting(db, CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY))

  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    const pendingEscalations = queries
      .getPendingEscalations(db, room.id)
      .filter((item) => item.toAgentId == null && item.fromAgentId != null && item.id > escalationCursor)
      .sort((a, b) => a.id - b.id)

    for (const escalation of pendingEscalations) {
      const content = buildEscalationAlert(db, room, escalation)
      if (!content) continue
      const sent = await sendClerkAlert(db, { source: 'escalation', content })
      if (!sent) return
      escalationCursor = escalation.id
      queries.setSetting(db, CLERK_NOTIFY_ESCALATION_CURSOR_KEY, String(escalationCursor))
      queries.logRoomActivity(
        db,
        room.id,
        'system',
        `Clerk forwarded escalation #${escalation.id} to keeper channels`,
        clip(escalation.question, 220)
      )
    }

    const pendingDecisions = queries
      .listDecisions(db, room.id, 'voting')
      .filter((item) => !item.keeperVote && item.id > decisionCursor)
      .sort((a, b) => a.id - b.id)

    for (const decision of pendingDecisions) {
      const content = buildDecisionAlert(room, decision)
      if (!content) continue
      const sent = await sendClerkAlert(db, { source: 'decision', content })
      if (!sent) return
      decisionCursor = decision.id
      queries.setSetting(db, CLERK_NOTIFY_DECISION_CURSOR_KEY, String(decisionCursor))
      queries.logRoomActivity(
        db,
        room.id,
        'decision',
        `Clerk requested keeper vote for decision #${decision.id}`,
        clip(decision.proposal, 220)
      )
    }

    const unreadInbound = queries
      .listRoomMessages(db, room.id, 'unread')
      .filter((item) => item.direction === 'inbound' && item.id > roomMessageCursor)
      .sort((a, b) => a.id - b.id)

    for (const message of unreadInbound) {
      const content = buildRoomMessageAlert(room, message)
      if (!content) continue
      const sent = await sendClerkAlert(db, { source: 'room_message', content })
      if (!sent) return
      roomMessageCursor = message.id
      queries.setSetting(db, CLERK_NOTIFY_ROOM_MESSAGE_CURSOR_KEY, String(roomMessageCursor))
      queries.logRoomActivity(
        db,
        room.id,
        'system',
        `Clerk forwarded inbox message #${message.id} to keeper channels`,
        clip(message.subject, 220)
      )
    }
  }
}
