import crypto from 'node:crypto'
import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { isCloudDeployment, getToken } from '../auth'
import { ensureCloudRoomToken, getRoomCloudId, getStoredCloudRoomToken } from '../../shared/cloud-sync'
import { triggerAgent } from '../../shared/agent-loop'
import { runClerkAssistantTurn } from './clerk'
import { getClerkNotifyPreferences } from '../clerk-notifications'
import { insertClerkMessageAndEmit } from '../clerk-message-events'

const EMAIL_VERIFY_CODE_TTL_MINUTES = 15
const EMAIL_RESEND_COOLDOWN_SECONDS = 60
const EMAIL_MAX_SENDS_PER_HOUR = 6
const TELEGRAM_VERIFY_TTL_MINUTES = 20
const DEFAULT_TELEGRAM_BOT_USERNAME = 'quoroom_ai_bot'
const CLERK_TELEGRAM_TYPING_INTERVAL_MS = 3_500

const CONTACT_EMAIL_KEY = 'contact_email'
const CONTACT_EMAIL_VERIFIED_AT_KEY = 'contact_email_verified_at'
const CONTACT_EMAIL_CODE_HASH_KEY = 'contact_email_verify_code_hash'
const CONTACT_EMAIL_CODE_EXPIRES_AT_KEY = 'contact_email_verify_code_expires_at'
const CONTACT_EMAIL_LAST_SENT_AT_KEY = 'contact_email_verify_last_sent_at'
const CONTACT_EMAIL_RATE_WINDOW_START_KEY = 'contact_email_verify_rate_window_start'
const CONTACT_EMAIL_RATE_WINDOW_COUNT_KEY = 'contact_email_verify_rate_window_count'
const CONTACT_EMAIL_RELAY_ROOM_ID_KEY = 'contact_email_relay_room_id'

const CONTACT_TELEGRAM_ID_KEY = 'contact_telegram_id'
const CONTACT_TELEGRAM_USERNAME_KEY = 'contact_telegram_username'
const CONTACT_TELEGRAM_FIRST_NAME_KEY = 'contact_telegram_first_name'
const CONTACT_TELEGRAM_VERIFIED_AT_KEY = 'contact_telegram_verified_at'
const CONTACT_TELEGRAM_PENDING_HASH_KEY = 'contact_telegram_pending_hash'
const CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY = 'contact_telegram_pending_expires_at'
const CONTACT_TELEGRAM_BOT_USERNAME_KEY = 'contact_telegram_bot_username'
const CLERK_EMAIL_WELCOME_SENT_AT_KEY = 'clerk_email_welcome_sent_at'
const CLERK_TELEGRAM_WELCOME_SENT_AT_KEY = 'clerk_telegram_welcome_sent_at'

interface ApiErrorMeta {
  status: number
  message: string
  retryAfterSec?: number
}

class ApiError extends Error {
  status: number
  retryAfterSec?: number

  constructor(meta: ApiErrorMeta) {
    super(meta.message)
    this.status = meta.status
    this.retryAfterSec = meta.retryAfterSec
  }
}

interface CloudTelegramVerifyStartResponse {
  ok?: boolean
  botUsername?: string
}

interface CloudTelegramVerifyStatusResponse {
  ok?: boolean
  status?: string
  botUsername?: string
  telegram?: {
    id?: string | number
    username?: string | null
    firstName?: string | null
    verifiedAt?: string | null
  }
}

interface CloudTelegramVerifyStatus {
  status: 'missing' | 'pending' | 'expired' | 'verified'
  botUsername: string
  telegramId: string | null
  username: string | null
  firstName: string | null
  verifiedAt: string | null
}

interface VerifiedContactBindingPayload {
  email: string | null
  emailVerifiedAt: string | null
  telegramId: string | null
  telegramUsername: string | null
  telegramFirstName: string | null
  telegramVerifiedAt: string | null
}

function getSettingTrimmed(db: Parameters<typeof queries.getSetting>[0], key: string): string {
  return (queries.getSetting(db, key) ?? '').trim()
}

function setSetting(db: Parameters<typeof queries.setSetting>[0], key: string, value: string): void {
  queries.setSetting(db, key, value)
}

function clearSetting(db: Parameters<typeof queries.setSetting>[0], key: string): void {
  queries.setSetting(db, key, '')
}

function parseIsoToMs(value: string): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return timestamp
}

function parseInteger(value: string, fallback: number = 0): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getContactSecret(): string {
  const configured = (process.env.QUOROOM_CONTACT_SECRET || '').trim()
  if (configured) return configured
  try {
    return getToken()
  } catch {
    return 'quoroom-contact-secret'
  }
}

function hashEmailCode(email: string, code: string): string {
  return crypto
    .createHmac('sha256', getContactSecret())
    .update(`email:${email.toLowerCase()}\ncode:${code}`)
    .digest('hex')
}

function hashTelegramToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function hashesEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function getCloudApiBase(): string {
  return (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.io/api').replace(/\/+$/, '')
}

function getTelegramBotUsername(): string {
  const configured = (process.env.QUOROOM_TELEGRAM_BOT_USERNAME || '').trim().replace(/^@+/, '')
  return configured || DEFAULT_TELEGRAM_BOT_USERNAME
}

function normalizeBotUsername(input: string | null | undefined): string {
  if (typeof input !== 'string') return getTelegramBotUsername()
  const value = input.trim().replace(/^@+/, '')
  return value || getTelegramBotUsername()
}

function isValidEmail(input: string): boolean {
  if (!input || input.length > 320) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)
}

function isValidCloudRoomId(input: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(input)
}

function createEmailRelayRoomId(): string {
  return `contact_${crypto.randomBytes(16).toString('hex')}`
}

async function getEmailRelayAuth(
  db: Parameters<typeof queries.getSetting>[0],
): Promise<{ roomId: string; roomToken: string }> {
  let roomId = getSettingTrimmed(db, CONTACT_EMAIL_RELAY_ROOM_ID_KEY)
  if (!isValidCloudRoomId(roomId)) {
    roomId = createEmailRelayRoomId()
    setSetting(db, CONTACT_EMAIL_RELAY_ROOM_ID_KEY, roomId)
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cachedToken = getStoredCloudRoomToken(roomId)
    if (cachedToken) return { roomId, roomToken: cachedToken }

    const hasToken = await ensureCloudRoomToken({
      roomId,
      name: 'Keeper Contact Relay',
      goal: 'Relay keeper contact verification emails',
      visibility: 'private',
    })
    const issuedToken = getStoredCloudRoomToken(roomId)
    if (hasToken && issuedToken) return { roomId, roomToken: issuedToken }

    roomId = createEmailRelayRoomId()
    setSetting(db, CONTACT_EMAIL_RELAY_ROOM_ID_KEY, roomId)
  }

  throw new ApiError({
    status: 503,
    message: 'Cloud relay room token is unavailable. Check connection and retry.',
  })
}

function emailSendGate(db: Parameters<typeof queries.getSetting>[0], nowMs: number): { windowStartMs: number; windowCount: number } {
  const lastSentAt = parseIsoToMs(getSettingTrimmed(db, CONTACT_EMAIL_LAST_SENT_AT_KEY))
  if (lastSentAt != null) {
    const retryMs = EMAIL_RESEND_COOLDOWN_SECONDS * 1000 - (nowMs - lastSentAt)
    if (retryMs > 0) {
      throw new ApiError({
        status: 429,
        message: `Please wait ${Math.ceil(retryMs / 1000)}s before resending.`,
        retryAfterSec: Math.ceil(retryMs / 1000),
      })
    }
  }

  let windowStartMs = parseIsoToMs(getSettingTrimmed(db, CONTACT_EMAIL_RATE_WINDOW_START_KEY))
  let windowCount = parseInteger(getSettingTrimmed(db, CONTACT_EMAIL_RATE_WINDOW_COUNT_KEY), 0)
  if (windowStartMs == null || (nowMs - windowStartMs) >= 60 * 60 * 1000) {
    windowStartMs = nowMs
    windowCount = 0
  }

  if (windowCount >= EMAIL_MAX_SENDS_PER_HOUR) {
    const retryMs = Math.max(1_000, 60 * 60 * 1000 - (nowMs - windowStartMs))
    throw new ApiError({
      status: 429,
      message: 'Too many verification emails sent. Please try again later.',
      retryAfterSec: Math.ceil(retryMs / 1000),
    })
  }

  return { windowStartMs, windowCount }
}

async function sendVerificationCodeEmail(
  db: Parameters<typeof queries.getSetting>[0],
  email: string,
  code: string,
  retryOnAuthFailure: boolean = true,
): Promise<void> {
  const { roomId, roomToken } = await getEmailRelayAuth(db)
  const res = await fetch(`${getCloudApiBase()}/contacts/email/send-code/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': roomToken,
    },
    body: JSON.stringify({
      email,
      code,
      ttlMinutes: EMAIL_VERIFY_CODE_TTL_MINUTES,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    if (retryOnAuthFailure && (res.status === 401 || res.status === 404)) {
      setSetting(db, CONTACT_EMAIL_RELAY_ROOM_ID_KEY, createEmailRelayRoomId())
      return sendVerificationCodeEmail(db, email, code, false)
    }
    const details = await res.text().catch(() => '')
    throw new ApiError({
      status: 502,
      message: `Failed to send verification email (${res.status}). ${details.slice(0, 180)}`.trim(),
    })
  }
}

async function issueEmailVerification(
  db: Parameters<typeof queries.getSetting>[0],
  email: string,
): Promise<{ sentTo: string; expiresAt: string; retryAfterSec: number }> {
  const nowMs = Date.now()
  const { windowStartMs, windowCount } = emailSendGate(db, nowMs)
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
  await sendVerificationCodeEmail(db, email, code)

  const nowIso = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + EMAIL_VERIFY_CODE_TTL_MINUTES * 60 * 1000).toISOString()
  const codeHash = hashEmailCode(email, code)

  setSetting(db, CONTACT_EMAIL_KEY, email)
  clearSetting(db, CONTACT_EMAIL_VERIFIED_AT_KEY)
  setSetting(db, CONTACT_EMAIL_CODE_HASH_KEY, codeHash)
  setSetting(db, CONTACT_EMAIL_CODE_EXPIRES_AT_KEY, expiresAt)
  setSetting(db, CONTACT_EMAIL_LAST_SENT_AT_KEY, nowIso)
  setSetting(db, CONTACT_EMAIL_RATE_WINDOW_START_KEY, new Date(windowStartMs).toISOString())
  setSetting(db, CONTACT_EMAIL_RATE_WINDOW_COUNT_KEY, String(windowCount + 1))

  return {
    sentTo: email,
    expiresAt,
    retryAfterSec: EMAIL_RESEND_COOLDOWN_SECONDS,
  }
}

async function startCloudTelegramVerification(tokenHash: string, expiresAt: string): Promise<string> {
  const res = await fetch(`${getCloudApiBase()}/telegram/verify/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenHash, expiresAt }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const details = await res.text().catch(() => '')
    throw new ApiError({
      status: 502,
      message: `Telegram verification service unavailable (${res.status}). ${details.slice(0, 180)}`.trim(),
    })
  }
  const payload = await res.json().catch(() => ({})) as CloudTelegramVerifyStartResponse
  return normalizeBotUsername(payload.botUsername)
}

async function fetchCloudTelegramVerificationStatus(tokenHash: string): Promise<CloudTelegramVerifyStatus> {
  const fallbackBot = getTelegramBotUsername()
  const res = await fetch(`${getCloudApiBase()}/telegram/verify/status/${encodeURIComponent(tokenHash)}`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const details = await res.text().catch(() => '')
    throw new ApiError({
      status: 502,
      message: `Telegram verification status unavailable (${res.status}). ${details.slice(0, 180)}`.trim(),
    })
  }
  const payload = await res.json().catch(() => ({})) as CloudTelegramVerifyStatusResponse
  const status = payload.status
  const normalizedStatus: CloudTelegramVerifyStatus['status'] = status === 'verified'
    ? 'verified'
    : status === 'expired'
      ? 'expired'
      : status === 'missing'
        ? 'missing'
        : 'pending'
  const telegramId = payload.telegram?.id == null ? null : String(payload.telegram.id)
  return {
    status: normalizedStatus,
    botUsername: normalizeBotUsername(payload.botUsername ?? fallbackBot),
    telegramId,
    username: payload.telegram?.username ?? null,
    firstName: payload.telegram?.firstName ?? null,
    verifiedAt: payload.telegram?.verifiedAt ?? null,
  }
}

function getContactsStatus(db: Parameters<typeof queries.getSetting>[0]): Record<string, unknown> {
  const nowMs = Date.now()
  const notifyPrefs = getClerkNotifyPreferences(db)

  const email = getSettingTrimmed(db, CONTACT_EMAIL_KEY) || null
  const emailVerifiedAt = getSettingTrimmed(db, CONTACT_EMAIL_VERIFIED_AT_KEY) || null
  const emailExpiresAtRaw = getSettingTrimmed(db, CONTACT_EMAIL_CODE_EXPIRES_AT_KEY)
  const emailExpiresAtMs = parseIsoToMs(emailExpiresAtRaw)
  const emailPending = Boolean(getSettingTrimmed(db, CONTACT_EMAIL_CODE_HASH_KEY))
    && emailExpiresAtMs != null
    && emailExpiresAtMs > nowMs
  const emailLastSentMs = parseIsoToMs(getSettingTrimmed(db, CONTACT_EMAIL_LAST_SENT_AT_KEY))
  const emailRetryAfterSec = emailLastSentMs == null
    ? 0
    : Math.max(0, Math.ceil(((emailLastSentMs + EMAIL_RESEND_COOLDOWN_SECONDS * 1000) - nowMs) / 1000))

  const telegramId = getSettingTrimmed(db, CONTACT_TELEGRAM_ID_KEY) || null
  const telegramUsername = getSettingTrimmed(db, CONTACT_TELEGRAM_USERNAME_KEY) || null
  const telegramFirstName = getSettingTrimmed(db, CONTACT_TELEGRAM_FIRST_NAME_KEY) || null
  const telegramVerifiedAt = getSettingTrimmed(db, CONTACT_TELEGRAM_VERIFIED_AT_KEY) || null
  const telegramPendingHash = getSettingTrimmed(db, CONTACT_TELEGRAM_PENDING_HASH_KEY)
  const telegramPendingExpiresAtRaw = getSettingTrimmed(db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
  const telegramPendingExpiresAtMs = parseIsoToMs(telegramPendingExpiresAtRaw)
  const telegramPending = telegramPendingHash.length > 0
    && telegramPendingExpiresAtMs != null
    && telegramPendingExpiresAtMs > nowMs
  const telegramBotUsername = normalizeBotUsername(
    getSettingTrimmed(db, CONTACT_TELEGRAM_BOT_USERNAME_KEY) || getTelegramBotUsername()
  )

  return {
    deploymentMode: isCloudDeployment() ? 'cloud' : 'local',
    notifications: {
      email: notifyPrefs.email,
      telegram: notifyPrefs.telegram,
    },
    email: {
      value: email,
      verified: Boolean(emailVerifiedAt),
      verifiedAt: emailVerifiedAt,
      pending: emailPending,
      pendingExpiresAt: emailPending ? telegramSafeIso(emailExpiresAtRaw) : null,
      resendRetryAfterSec: emailRetryAfterSec,
    },
    telegram: {
      id: telegramId,
      username: telegramUsername,
      firstName: telegramFirstName,
      verified: Boolean(telegramVerifiedAt),
      verifiedAt: telegramVerifiedAt,
      pending: telegramPending,
      pendingExpiresAt: telegramPending ? telegramSafeIso(telegramPendingExpiresAtRaw) : null,
      botUsername: telegramBotUsername,
    },
  }
}

function telegramSafeIso(value: string): string | null {
  return parseIsoToMs(value) == null ? null : value
}

function getVerifiedContactBindingPayload(
  db: Parameters<typeof queries.getSetting>[0],
): VerifiedContactBindingPayload {
  const email = getSettingTrimmed(db, CONTACT_EMAIL_KEY).toLowerCase()
  const emailVerifiedAtRaw = getSettingTrimmed(db, CONTACT_EMAIL_VERIFIED_AT_KEY)
  const emailVerifiedAt = parseIsoToMs(emailVerifiedAtRaw) == null ? null : emailVerifiedAtRaw
  const hasVerifiedEmail = isValidEmail(email) && Boolean(emailVerifiedAt)

  const telegramIdRaw = getSettingTrimmed(db, CONTACT_TELEGRAM_ID_KEY)
  const telegramId = /^-?\d{5,20}$/.test(telegramIdRaw) ? telegramIdRaw : null
  const telegramVerifiedAtRaw = getSettingTrimmed(db, CONTACT_TELEGRAM_VERIFIED_AT_KEY)
  const telegramVerifiedAt = parseIsoToMs(telegramVerifiedAtRaw) == null ? null : telegramVerifiedAtRaw
  const hasVerifiedTelegram = Boolean(telegramId) && Boolean(telegramVerifiedAt)

  return {
    email: hasVerifiedEmail ? email : null,
    emailVerifiedAt: hasVerifiedEmail ? emailVerifiedAt : null,
    telegramId: hasVerifiedTelegram ? telegramId : null,
    telegramUsername: hasVerifiedTelegram ? (getSettingTrimmed(db, CONTACT_TELEGRAM_USERNAME_KEY) || null) : null,
    telegramFirstName: hasVerifiedTelegram ? (getSettingTrimmed(db, CONTACT_TELEGRAM_FIRST_NAME_KEY) || null) : null,
    telegramVerifiedAt: hasVerifiedTelegram ? telegramVerifiedAt : null,
  }
}

function hasVerifiedContacts(payload: VerifiedContactBindingPayload): boolean {
  return Boolean(payload.email && payload.emailVerifiedAt)
    || Boolean(payload.telegramId && payload.telegramVerifiedAt)
}

async function syncCloudContactBindings(
  db: Parameters<typeof queries.getSetting>[0],
): Promise<void> {
  if (isCloudDeployment()) return

  const rooms = queries.listRooms(db)
  if (rooms.length === 0) return

  const payload = getVerifiedContactBindingPayload(db)
  const hasContacts = hasVerifiedContacts(payload)
  const keeperReferralCodeRaw = getSettingTrimmed(db, 'keeper_referral_code')
  const keeperReferralCode = keeperReferralCodeRaw || null
  const keeperUserNumberRaw = getSettingTrimmed(db, 'keeper_user_number')
  const keeperUserNumber = /^\d{5,6}$/.test(keeperUserNumberRaw) ? Number(keeperUserNumberRaw) : null

  for (const room of rooms) {
    const cloudRoomId = getRoomCloudId(room.id)
    const hasToken = await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
      referredByCode: room.referredByCode,
      keeperReferralCode,
    })
    if (!hasToken) continue

    const roomToken = getStoredCloudRoomToken(cloudRoomId)
    if (!roomToken) continue

    const endpoint = `${getCloudApiBase()}/contacts/bindings/${encodeURIComponent(cloudRoomId)}`
    const method = hasContacts ? 'POST' : 'DELETE'
    const bindingPayload = hasContacts ? {
      ...payload,
      queenNickname: room.queenNickname ?? null,
      keeperUserNumber,
    } : undefined
    const res = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Room-Token': roomToken,
      },
      body: bindingPayload ? JSON.stringify(bindingPayload) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const details = await res.text().catch(() => '')
      throw new ApiError({
        status: 502,
        message: `Failed to sync contact bindings (${res.status}). ${details.slice(0, 180)}`.trim(),
      })
    }
  }
}

function getKeeperUserNumber(db: Parameters<typeof queries.getSetting>[0]): number | null {
  const raw = getSettingTrimmed(db, 'keeper_user_number')
  if (!/^\d{5,6}$/.test(raw)) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

async function getAnyCloudRoomAuth(
  db: Parameters<typeof queries.getSetting>[0],
): Promise<{ cloudRoomId: string; roomToken: string } | null> {
  const rooms = queries.listRooms(db)
  if (rooms.length === 0) return null

  const keeperReferralCodeRaw = getSettingTrimmed(db, 'keeper_referral_code')
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

function storeClerkContactMemory(
  db: Parameters<typeof queries.getSetting>[0],
  input: {
    direction: 'inbound' | 'outbound'
    channel: 'email' | 'telegram'
    content: string
  },
): void {
  const body = input.content.trim()
  if (!body) return

  const role = input.direction === 'inbound' ? 'user' : 'assistant'
  insertClerkMessageAndEmit(db, role, body, input.channel)
  if (input.direction === 'inbound') {
    setSetting(db, 'clerk_last_user_message_at', new Date().toISOString())
  }
}

function clerkWelcomeKey(channel: 'email' | 'telegram'): string {
  return channel === 'email' ? CLERK_EMAIL_WELCOME_SENT_AT_KEY : CLERK_TELEGRAM_WELCOME_SENT_AT_KEY
}

function buildClerkWelcomeMessage(channel: 'email' | 'telegram'): string {
  if (channel === 'email') {
    return 'Hi, this is your Clerk. Email is now connected. Reply here anytime and I will keep it in your system memory. I can also help you control your swarm — ask me about any task, room, or change.'
  }
  return 'Hi, this is your Clerk. Telegram is now connected. Reply here anytime and I will keep it in your system memory. I can also help you control your swarm — ask me about any task, room, or change.'
}

async function sendClerkWelcome(
  db: Parameters<typeof queries.getSetting>[0],
  channel: 'email' | 'telegram',
): Promise<boolean> {
  if (isCloudDeployment()) return false
  if (getSettingTrimmed(db, clerkWelcomeKey(channel))) return true

  const keeperUserNumber = getKeeperUserNumber(db)
  if (!keeperUserNumber) return false

  const auth = await getAnyCloudRoomAuth(db)
  if (!auth) return false

  const content = buildClerkWelcomeMessage(channel)
  const res = await fetch(`${getCloudApiBase()}/contacts/queen-message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': auth.roomToken,
    },
    body: JSON.stringify({
      roomId: auth.cloudRoomId,
      queenNickname: 'clerk',
      userNumber: keeperUserNumber,
      question: content,
      channels: [channel],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return false

  const payload = await res.json().catch(() => ({})) as { email?: string; telegram?: string }
  const sent = channel === 'email'
    ? payload.email === 'sent'
    : payload.telegram === 'sent'

  storeClerkContactMemory(db, {
    direction: 'outbound',
    channel,
    content
  })
  if (!sent) return false

  setSetting(db, clerkWelcomeKey(channel), new Date().toISOString())
  return true
}

async function sendClerkWelcomeSafe(
  db: Parameters<typeof queries.getSetting>[0],
  channel: 'email' | 'telegram',
): Promise<void> {
  try {
    await sendClerkWelcome(db, channel)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[contacts] clerk ${channel} welcome skipped: ${message}`)
  }
}

function buildClerkReplyFallback(
  db: Parameters<typeof queries.getSetting>[0],
  inbound: { body: string },
): string {
  const activeRooms = queries.listRooms(db, 'active')
  const roomSummary = activeRooms.length > 0
    ? activeRooms.slice(0, 4).map((room) => room.name).join(', ')
    : 'no active rooms right now'
  return [
    `I got your message: "${inbound.body.trim().slice(0, 220)}"`,
    `Current swarm snapshot: ${roomSummary}.`,
    'I can create rooms, update settings, stop/delete rooms, send messages, and schedule reminders for you.',
    'Tell me exactly what action you want next and I will execute it.',
  ].join('\n')
}

function normalizeClerkContactReply(
  channel: 'email' | 'telegram',
  content: string,
): string {
  let text = content.trim()

  // Remove leading "Clerk:" label if model adds it.
  text = text.replace(/^\s*clerk\s*:\s*/i, '')
  text = text.replace(/^\s*\*{1,2}\s*clerk\s*\*{1,2}\s*:\s*/i, '')
  text = text.replace(/^\s*<b>\s*clerk\s*<\/b>\s*:\s*/i, '')

  // Remove trailing signature markers to control per-channel style.
  text = text.replace(/\n?\s*[—-]\s*clerk\s*$/i, '')
  text = text.replace(/\n?\s*clerk\s*$/i, '')
  text = text.replace(/\n?\s*\*{1,2}\s*[—-]?\s*clerk\s*\*{1,2}\s*$/i, '')
  text = text.replace(/\n?\s*<b>\s*[—-]?\s*clerk\s*<\/b>\s*$/i, '')

  text = text.trim()
  if (!text) text = 'Here and active. What do you want next?'

  // Telegram: no signature, plain direct message.
  if (channel === 'telegram') {
    return text
  }

  // Email: keep a traditional signature.
  if (!/\n\s*[—-]\s*clerk\s*$/i.test(text)) {
    text = `${text}\n\n— Clerk`
  }
  return text
}

async function sendClerkContactReply(
  db: Parameters<typeof queries.getSetting>[0],
  input: {
    cloudRoomId: string
    roomToken: string
    channel: 'email' | 'telegram'
    content: string
  },
): Promise<boolean> {
  const keeperUserNumber = getKeeperUserNumber(db)
  const formattedContent = normalizeClerkContactReply(input.channel, input.content)
  const res = await fetch(`${getCloudApiBase()}/contacts/queen-message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': input.roomToken,
    },
    body: JSON.stringify({
      roomId: input.cloudRoomId,
      queenNickname: 'clerk',
      userNumber: keeperUserNumber,
      question: formattedContent,
      channels: [input.channel],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return false
  const payload = await res.json().catch(() => ({})) as { email?: string; telegram?: string }
  return input.channel === 'email'
    ? payload.email === 'sent'
    : payload.telegram === 'sent'
}

async function sendClerkTelegramTyping(
  input: {
    cloudRoomId: string
    roomToken: string
  },
): Promise<void> {
  await fetch(`${getCloudApiBase()}/contacts/queen-typing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': input.roomToken,
    },
    body: JSON.stringify({
      roomId: input.cloudRoomId,
      channel: 'telegram',
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { /* best effort */ })
}

function startClerkTelegramTypingLoop(
  input: {
    cloudRoomId: string
    roomToken: string
  },
): () => void {
  let stopped = false
  const tick = () => {
    if (stopped) return
    void sendClerkTelegramTyping(input)
  }

  tick()
  const interval = setInterval(tick, CLERK_TELEGRAM_TYPING_INTERVAL_MS)
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

interface QueenInboxMessage {
  id: number
  queenNickname: string
  channel: string
  body: string
}

interface QueenInboxResponse {
  messages?: QueenInboxMessage[]
  ok?: boolean
}

interface PollQueenInboxOptions {
  runClerkTurn?: typeof runClerkAssistantTurn
}

export async function pollQueenInbox(
  db: Parameters<typeof queries.getSetting>[0],
  options: PollQueenInboxOptions = {},
): Promise<void> {
  if (isCloudDeployment()) return
  const runClerkTurn = options.runClerkTurn ?? runClerkAssistantTurn

  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    try {
      const cloudRoomId = getRoomCloudId(room.id)
      const roomToken = getStoredCloudRoomToken(cloudRoomId)
      if (!roomToken) continue

      const res = await fetch(`${getCloudApiBase()}/contacts/queen-inbox/${encodeURIComponent(cloudRoomId)}`, {
        headers: { 'X-Room-Token': roomToken },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) continue

      const data = await res.json() as QueenInboxResponse
      const messages = data.messages ?? []
      if (messages.length === 0) continue

      const messageIds: number[] = []
      let shouldWakeQueen = false
      for (const msg of messages) {
        const nickname = msg.queenNickname || 'Queen'
        const channel = msg.channel || 'external'
        if (nickname.toLowerCase() === 'clerk') {
          const safeChannel = channel === 'email' ? 'email' : 'telegram'
          storeClerkContactMemory(db, {
            direction: 'inbound',
            channel: safeChannel,
            content: msg.body
          })
          queries.logRoomActivity(db, room.id, 'system', `Keeper messaged Clerk via ${safeChannel}`, msg.body.slice(0, 200))

          const stopTyping = safeChannel === 'telegram'
            ? startClerkTelegramTypingLoop({ cloudRoomId, roomToken })
            : null

          try {
            const turn = await runClerkTurn(db, msg.body, {
              skipUserInsert: true,
            })
            let reply = turn.ok ? (turn.response ?? '').trim() : ''
            if (!reply) {
              reply = buildClerkReplyFallback(db, { body: msg.body })
            }
            const replyToSend = normalizeClerkContactReply(safeChannel, reply)

            const sent = await sendClerkContactReply(db, {
              cloudRoomId,
              roomToken,
              channel: safeChannel,
              content: replyToSend,
            })
            storeClerkContactMemory(db, {
              direction: 'outbound',
              channel: safeChannel,
              content: replyToSend,
            })
            if (sent) {
              queries.logRoomActivity(db, room.id, 'system', `Clerk replied via ${safeChannel}`, replyToSend.slice(0, 200))
            } else {
              queries.logRoomActivity(
                db,
                room.id,
                'system',
                `Clerk reply delivery failed via ${safeChannel}`,
                turn.error?.slice(0, 200) ?? 'Unable to deliver Clerk reply'
              )
            }
          } finally {
            stopTyping?.()
          }
        } else {
          const body = `[Reply from keeper via ${channel} to ${nickname}]\n${msg.body}`
          queries.createEscalation(db, room.id, null, body, room.queenWorkerId ?? undefined)
          queries.logRoomActivity(db, room.id, 'system', `Keeper replied to ${nickname} via ${channel}`, msg.body.slice(0, 200))
          shouldWakeQueen = true
        }
        messageIds.push(msg.id)
      }

      // Ack delivered messages
      if (messageIds.length > 0) {
        await fetch(`${getCloudApiBase()}/contacts/queen-inbox/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Room-Token': roomToken },
          body: JSON.stringify({ roomId: cloudRoomId, messageIds }),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => { /* best-effort */ })

        // Wake the queen immediately — bypasses gap sleep and quiet hours
        if (shouldWakeQueen && room.queenWorkerId) {
          triggerAgent(db, room.id, room.queenWorkerId)
        }
      }
    } catch {
      // Best-effort: skip this room on error
    }
  }
}

async function syncCloudContactBindingsSafe(
  db: Parameters<typeof queries.getSetting>[0],
): Promise<void> {
  try {
    await syncCloudContactBindings(db)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[contacts] contact binding sync skipped: ${message}`)
  }
}

export function registerContactRoutes(router: Router): void {
  router.get('/api/contacts/status', (ctx) => {
    return { data: getContactsStatus(ctx.db) }
  })

  router.post('/api/contacts/email/start', async (ctx) => {
    const body = (ctx.body as Record<string, unknown>) ?? {}
    const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!isValidEmail(emailRaw)) {
      return { status: 400, error: 'Valid email is required' }
    }

    const currentEmail = getSettingTrimmed(ctx.db, CONTACT_EMAIL_KEY).toLowerCase()
    const verifiedAt = getSettingTrimmed(ctx.db, CONTACT_EMAIL_VERIFIED_AT_KEY)
    if (currentEmail === emailRaw && verifiedAt) {
      return { data: { ok: true, alreadyVerified: true, email: emailRaw } }
    }

    try {
      const result = await issueEmailVerification(ctx.db, emailRaw)
      void syncCloudContactBindingsSafe(ctx.db)
      return { data: { ok: true, ...result } }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, error: error.message }
      }
      return { status: 500, error: 'Failed to send verification email' }
    }
  })

  router.post('/api/contacts/email/resend', async (ctx) => {
    const email = getSettingTrimmed(ctx.db, CONTACT_EMAIL_KEY).toLowerCase()
    if (!isValidEmail(email)) {
      return { status: 400, error: 'No email to resend verification to' }
    }

    const verifiedAt = getSettingTrimmed(ctx.db, CONTACT_EMAIL_VERIFIED_AT_KEY)
    if (verifiedAt) {
      return { data: { ok: true, alreadyVerified: true, email } }
    }

    try {
      const result = await issueEmailVerification(ctx.db, email)
      return { data: { ok: true, ...result } }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, error: error.message }
      }
      return { status: 500, error: 'Failed to resend verification email' }
    }
  })

  router.post('/api/contacts/email/verify', async (ctx) => {
    const body = (ctx.body as Record<string, unknown>) ?? {}
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!/^\d{6}$/.test(code)) {
      return { status: 400, error: 'Verification code must be 6 digits' }
    }

    const email = getSettingTrimmed(ctx.db, CONTACT_EMAIL_KEY).toLowerCase()
    const storedHash = getSettingTrimmed(ctx.db, CONTACT_EMAIL_CODE_HASH_KEY).toLowerCase()
    const expiresAtRaw = getSettingTrimmed(ctx.db, CONTACT_EMAIL_CODE_EXPIRES_AT_KEY)
    const expiresAtMs = parseIsoToMs(expiresAtRaw)
    if (!isValidEmail(email) || !storedHash || expiresAtMs == null) {
      return { status: 400, error: 'No pending verification code. Request a new code first.' }
    }
    if (expiresAtMs <= Date.now()) {
      clearSetting(ctx.db, CONTACT_EMAIL_CODE_HASH_KEY)
      clearSetting(ctx.db, CONTACT_EMAIL_CODE_EXPIRES_AT_KEY)
      return { status: 400, error: 'Verification code expired. Request a new code.' }
    }

    const expectedHash = hashEmailCode(email, code).toLowerCase()
    if (!hashesEqualHex(storedHash, expectedHash)) {
      return { status: 400, error: 'Invalid verification code' }
    }

    const verifiedAt = new Date().toISOString()
    setSetting(ctx.db, CONTACT_EMAIL_VERIFIED_AT_KEY, verifiedAt)
    clearSetting(ctx.db, CONTACT_EMAIL_CODE_HASH_KEY)
    clearSetting(ctx.db, CONTACT_EMAIL_CODE_EXPIRES_AT_KEY)
    await syncCloudContactBindingsSafe(ctx.db)
    await sendClerkWelcomeSafe(ctx.db, 'email')
    return {
      data: {
        ok: true,
        email,
        verifiedAt,
      }
    }
  })

  router.post('/api/contacts/telegram/start', async (ctx) => {
    const token = crypto.randomBytes(24).toString('base64url')
    const tokenHash = hashTelegramToken(token)
    const expiresAt = new Date(Date.now() + TELEGRAM_VERIFY_TTL_MINUTES * 60 * 1000).toISOString()

    try {
      const botUsername = await startCloudTelegramVerification(tokenHash, expiresAt)
      setSetting(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY, tokenHash)
      setSetting(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY, expiresAt)
      setSetting(ctx.db, CONTACT_TELEGRAM_BOT_USERNAME_KEY, botUsername)

      const deepLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(`tv1_${token}`)}`
      return {
        data: {
          ok: true,
          pending: true,
          expiresAt,
          botUsername,
          deepLink,
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, error: error.message }
      }
      return { status: 500, error: 'Failed to start Telegram verification' }
    }
  })

  router.post('/api/contacts/telegram/check', async (ctx) => {
    const tokenHash = getSettingTrimmed(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY).toLowerCase()
    const expiresAtRaw = getSettingTrimmed(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
    const expiresAtMs = parseIsoToMs(expiresAtRaw)
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || expiresAtMs == null) {
      return { data: { ok: true, status: 'not_pending' } }
    }

    if (expiresAtMs <= Date.now()) {
      clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY)
      clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
      return { data: { ok: true, status: 'expired' } }
    }

    try {
      const status = await fetchCloudTelegramVerificationStatus(tokenHash)
      setSetting(ctx.db, CONTACT_TELEGRAM_BOT_USERNAME_KEY, status.botUsername)

      if (status.status === 'verified' && status.telegramId) {
        setSetting(ctx.db, CONTACT_TELEGRAM_ID_KEY, status.telegramId)
        setSetting(ctx.db, CONTACT_TELEGRAM_USERNAME_KEY, status.username ?? '')
        setSetting(ctx.db, CONTACT_TELEGRAM_FIRST_NAME_KEY, status.firstName ?? '')
        setSetting(ctx.db, CONTACT_TELEGRAM_VERIFIED_AT_KEY, status.verifiedAt ?? new Date().toISOString())
        clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY)
        clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
        await syncCloudContactBindingsSafe(ctx.db)
        await sendClerkWelcomeSafe(ctx.db, 'telegram')
        return {
          data: {
            ok: true,
            status: 'verified',
            telegram: {
              id: status.telegramId,
              username: status.username,
              firstName: status.firstName,
              verifiedAt: status.verifiedAt,
            },
          }
        }
      }

      if (status.status === 'expired' || status.status === 'missing') {
        clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY)
        clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
      }

      return {
        data: {
          ok: true,
          status: status.status,
          botUsername: status.botUsername,
        }
      }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, error: error.message }
      }
      return { status: 500, error: 'Failed to check Telegram verification status' }
    }
  })

  router.post('/api/contacts/telegram/disconnect', (ctx) => {
    clearSetting(ctx.db, CONTACT_TELEGRAM_ID_KEY)
    clearSetting(ctx.db, CONTACT_TELEGRAM_USERNAME_KEY)
    clearSetting(ctx.db, CONTACT_TELEGRAM_FIRST_NAME_KEY)
    clearSetting(ctx.db, CONTACT_TELEGRAM_VERIFIED_AT_KEY)
    clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_HASH_KEY)
    clearSetting(ctx.db, CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY)
    void syncCloudContactBindingsSafe(ctx.db)
    return { data: { ok: true } }
  })
}
