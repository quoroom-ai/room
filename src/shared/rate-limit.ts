import type { ExecutionResult } from './claude-code'

export interface RateLimitInfo {
  resetAt: Date | null
  waitMs: number
  rawMessage: string
}

export const RATE_LIMIT_MAX_RETRIES = 3
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000   // 5 minutes
export const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000      // 60 minutes
export const MIN_RATE_LIMIT_WAIT_MS = 30 * 1000            // 30 seconds

const RATE_LIMIT_PATTERNS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /too\s*many\s*requests/i,
  /\b429\b/,
  /rate_limit_error/i,
  /overloaded/i
]

/**
 * Detect whether an execution failure is due to a rate/usage limit.
 * Returns info about the limit (including when it resets) or null if not rate-limited.
 */
export function detectRateLimit(result: ExecutionResult): RateLimitInfo | null {
  if (result.exitCode === 0) return null
  if (result.timedOut) return null

  // Check stderr first (most common location), then stdout
  const textToCheck = [result.stderr, result.stdout].filter(Boolean)
  let matchedText = ''

  for (const text of textToCheck) {
    for (const pattern of RATE_LIMIT_PATTERNS) {
      if (pattern.test(text)) {
        matchedText = text
        break
      }
    }
    if (matchedText) break
  }

  if (!matchedText) return null

  const resetAt = parseResetTime(matchedText)
  let waitMs: number

  if (resetAt) {
    waitMs = resetAt.getTime() - Date.now()
  } else {
    waitMs = DEFAULT_RATE_LIMIT_WAIT_MS
  }

  // Clamp to bounds
  waitMs = Math.max(MIN_RATE_LIMIT_WAIT_MS, Math.min(MAX_RATE_LIMIT_WAIT_MS, waitMs))

  return { resetAt, waitMs, rawMessage: matchedText.slice(0, 500) }
}

/**
 * Try to extract a reset time from the error message.
 */
function parseResetTime(text: string): Date | null {
  // "reset at 2:30 PM (PST)" or "reset at 1pm (Etc/GMT+5)"
  const resetAtMatch = text.match(/reset\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\s*(?:\(([^)]+)\))?/i)
  if (resetAtMatch) {
    return parseTimeString(resetAtMatch[1], resetAtMatch[2])
  }

  // "reset in 5 minutes" / "try again in 30 seconds"
  const resetInMatch = text.match(/(?:reset|try\s+again)\s+in\s+(\d+)\s*(minute|min|second|sec|hour|hr)s?/i)
  if (resetInMatch) {
    const amount = parseInt(resetInMatch[1], 10)
    const unit = resetInMatch[2].toLowerCase()
    let ms = 0
    if (unit.startsWith('sec')) ms = amount * 1000
    else if (unit.startsWith('min')) ms = amount * 60 * 1000
    else if (unit.startsWith('h')) ms = amount * 60 * 60 * 1000
    if (ms > 0) return new Date(Date.now() + ms)
  }

  // Unix timestamp: "limit reached|1749924000" or "reset_at":1749924000
  const unixMatch = text.match(/(?:limit\s*reached|reset[_-]?at)\s*[|:="']\s*(\d{10,13})\b/)
  if (unixMatch) {
    const ts = parseInt(unixMatch[1], 10)
    // Handle seconds vs milliseconds
    const date = new Date(ts > 1e12 ? ts : ts * 1000)
    if (!isNaN(date.getTime())) return date
  }

  return null
}

/**
 * Parse a time string like "2:30 PM" or "1pm" into a Date (today or tomorrow).
 */
function parseTimeString(timeStr: string, _timezone?: string): Date | null {
  const cleaned = timeStr.trim()

  // Parse hour:minute AM/PM
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/i)
  if (!match) return null

  let hour = parseInt(match[1], 10)
  const minute = match[2] ? parseInt(match[2], 10) : 0
  const ampm = match[3]?.toUpperCase()

  if (ampm === 'PM' && hour < 12) hour += 12
  if (ampm === 'AM' && hour === 12) hour = 0

  const now = new Date()
  const resetDate = new Date(now)
  resetDate.setHours(hour, minute, 0, 0)

  // If the time is in the past, assume it means tomorrow
  if (resetDate.getTime() <= now.getTime()) {
    resetDate.setDate(resetDate.getDate() + 1)
  }

  return resetDate
}

/**
 * Sleep for a given duration. Optionally cancellable via AbortSignal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Rate limit wait aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Rate limit wait aborted'))
    }, { once: true })
  })
}
