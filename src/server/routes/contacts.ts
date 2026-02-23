import crypto from 'node:crypto'
import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { isCloudDeployment, getToken } from '../auth'

const EMAIL_VERIFY_CODE_TTL_MINUTES = 15
const EMAIL_RESEND_COOLDOWN_SECONDS = 60
const EMAIL_MAX_SENDS_PER_HOUR = 6
const TELEGRAM_VERIFY_TTL_MINUTES = 20
const DEFAULT_TELEGRAM_BOT_USERNAME = 'quoroom_ai_bot'

const CONTACT_EMAIL_KEY = 'contact_email'
const CONTACT_EMAIL_VERIFIED_AT_KEY = 'contact_email_verified_at'
const CONTACT_EMAIL_CODE_HASH_KEY = 'contact_email_verify_code_hash'
const CONTACT_EMAIL_CODE_EXPIRES_AT_KEY = 'contact_email_verify_code_expires_at'
const CONTACT_EMAIL_LAST_SENT_AT_KEY = 'contact_email_verify_last_sent_at'
const CONTACT_EMAIL_RATE_WINDOW_START_KEY = 'contact_email_verify_rate_window_start'
const CONTACT_EMAIL_RATE_WINDOW_COUNT_KEY = 'contact_email_verify_rate_window_count'

const CONTACT_TELEGRAM_ID_KEY = 'contact_telegram_id'
const CONTACT_TELEGRAM_USERNAME_KEY = 'contact_telegram_username'
const CONTACT_TELEGRAM_FIRST_NAME_KEY = 'contact_telegram_first_name'
const CONTACT_TELEGRAM_VERIFIED_AT_KEY = 'contact_telegram_verified_at'
const CONTACT_TELEGRAM_PENDING_HASH_KEY = 'contact_telegram_pending_hash'
const CONTACT_TELEGRAM_PENDING_EXPIRES_AT_KEY = 'contact_telegram_pending_expires_at'
const CONTACT_TELEGRAM_BOT_USERNAME_KEY = 'contact_telegram_bot_username'

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
  return (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.ai/api').replace(/\/+$/, '')
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

async function sendVerificationCodeEmail(email: string, code: string): Promise<void> {
  const apiKey = (process.env.QUOROOM_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim()
  if (!apiKey) {
    throw new ApiError({ status: 503, message: 'Email provider is not configured (RESEND_API_KEY).' })
  }

  const fromEmail = (process.env.QUOROOM_RESEND_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'Quoroom <noreply@quoroom.ai>').trim()
  const ttlLabel = `${EMAIL_VERIFY_CODE_TTL_MINUTES} minutes`
  const subject = 'Your Quoroom verification code'
  const text = [
    'Your Quoroom email verification code:',
    code,
    '',
    `This code expires in ${ttlLabel}.`,
    '',
    'If you did not request this code, you can ignore this email.',
  ].join('\n')
  const html = [
    '<div style="font-family:Arial,sans-serif;line-height:1.45;">',
    '<p>Your Quoroom email verification code:</p>',
    `<p style="font-size:24px;font-weight:700;letter-spacing:2px;margin:12px 0;">${code}</p>`,
    `<p>This code expires in ${ttlLabel}.</p>`,
    '<p style="color:#666;">If you did not request this code, you can ignore this email.</p>',
    '</div>',
  ].join('')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
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
  await sendVerificationCodeEmail(email, code)

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

  router.post('/api/contacts/email/verify', (ctx) => {
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
    return { data: { ok: true } }
  })
}
