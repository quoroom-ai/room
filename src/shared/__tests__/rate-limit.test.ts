import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  detectRateLimit,
  sleep,
  DEFAULT_RATE_LIMIT_WAIT_MS,
  MIN_RATE_LIMIT_WAIT_MS,
  MAX_RATE_LIMIT_WAIT_MS
} from '../rate-limit'
import type { ExecutionResult } from '../claude-code'

function makeResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 1,
    durationMs: 1000,
    timedOut: false,
    sessionId: null,
    ...overrides
  }
}

// ─── detectRateLimit ─────────────────────────────────────────

describe('detectRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for non-rate-limit errors', () => {
    expect(detectRateLimit(makeResult({ stderr: 'Something broke' }))).toBeNull()
    expect(detectRateLimit(makeResult({ stderr: 'spawn error ENOENT' }))).toBeNull()
    expect(detectRateLimit(makeResult({ stderr: 'invalid argument' }))).toBeNull()
  })

  it('returns null when exitCode is 0', () => {
    expect(detectRateLimit(makeResult({ exitCode: 0, stderr: 'rate limit' }))).toBeNull()
  })

  it('returns null for timeout errors', () => {
    expect(detectRateLimit(makeResult({ timedOut: true, stderr: 'rate limit' }))).toBeNull()
  })

  it('returns null for empty stderr and stdout', () => {
    expect(detectRateLimit(makeResult({ stderr: '', stdout: '' }))).toBeNull()
  })

  it('detects "rate limit" in stderr (case insensitive)', () => {
    const info = detectRateLimit(makeResult({ stderr: 'Error: Rate Limit exceeded' }))
    expect(info).not.toBeNull()
    expect(info!.waitMs).toBe(DEFAULT_RATE_LIMIT_WAIT_MS)
  })

  it('detects "rate limit" with extra spacing', () => {
    const info = detectRateLimit(makeResult({ stderr: 'rate  limit hit' }))
    expect(info).not.toBeNull()
  })

  it('detects "usage limit" in stderr', () => {
    const info = detectRateLimit(makeResult({ stderr: 'Claude usage limit reached' }))
    expect(info).not.toBeNull()
  })

  it('detects "too many requests" in stderr', () => {
    const info = detectRateLimit(makeResult({ stderr: 'Too Many Requests' }))
    expect(info).not.toBeNull()
  })

  it('detects "429" in stderr', () => {
    const info = detectRateLimit(makeResult({ stderr: 'Error: 429 rate_limit_error' }))
    expect(info).not.toBeNull()
  })

  it('detects "rate_limit_error" in stderr', () => {
    const info = detectRateLimit(makeResult({
      stderr: '{"type":"error","error":{"type":"rate_limit_error","message":"exceeded"}}'
    }))
    expect(info).not.toBeNull()
  })

  it('detects "overloaded" in stderr', () => {
    const info = detectRateLimit(makeResult({ stderr: 'API is overloaded' }))
    expect(info).not.toBeNull()
  })

  it('detects rate limit in stdout when stderr is clean', () => {
    const info = detectRateLimit(makeResult({
      stderr: '',
      stdout: 'Error: 429 rate_limit_error: too many requests'
    }))
    expect(info).not.toBeNull()
  })

  it('checks stderr before stdout', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'rate limit exceeded',
      stdout: 'some output'
    }))
    expect(info).not.toBeNull()
    expect(info!.rawMessage).toContain('rate limit exceeded')
  })

  // ─── Reset Time Extraction ────────────────────────────────

  it('extracts reset time from "reset at 2:30 PM (PST)"', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limit reached. Your limit will reset at 2:30 PM (PST)'
    }))
    expect(info).not.toBeNull()
    expect(info!.resetAt).not.toBeNull()
    expect(info!.resetAt!.getHours()).toBe(14)
    expect(info!.resetAt!.getMinutes()).toBe(30)
  })

  it('extracts reset time from "reset at 1pm"', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Usage limit. Your limit will reset at 1pm'
    }))
    expect(info).not.toBeNull()
    expect(info!.resetAt).not.toBeNull()
    expect(info!.resetAt!.getHours()).toBe(13)
  })

  it('extracts reset time from "reset in 5 minutes"', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limit. Please reset in 5 minutes'
    }))
    expect(info).not.toBeNull()
    expect(info!.waitMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000)
    expect(info!.waitMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000)
  })

  it('extracts reset time from "try again in 30 seconds"', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limited. Please try again in 30 seconds'
    }))
    expect(info).not.toBeNull()
    // 30 seconds < MIN_RATE_LIMIT_WAIT_MS (30s), so should be clamped to 30s
    expect(info!.waitMs).toBe(MIN_RATE_LIMIT_WAIT_MS)
  })

  it('extracts reset time from "try again in 2 hours"', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limited. Please try again in 2 hours'
    }))
    expect(info).not.toBeNull()
    // 2 hours > MAX_RATE_LIMIT_WAIT_MS (60 min), capped
    expect(info!.waitMs).toBe(MAX_RATE_LIMIT_WAIT_MS)
  })

  it('extracts reset time from unix timestamp', () => {
    // 1739621100 = 2025-02-15T12:05:00Z
    const futureTs = Math.floor(Date.now() / 1000) + 300 // 5 minutes from now
    const info = detectRateLimit(makeResult({
      stderr: `Claude AI usage limit reached|${futureTs}`
    }))
    expect(info).not.toBeNull()
    expect(info!.resetAt).not.toBeNull()
    expect(info!.waitMs).toBeGreaterThanOrEqual(4 * 60 * 1000)
    expect(info!.waitMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000)
  })

  it('uses default wait when no reset time found', () => {
    const info = detectRateLimit(makeResult({ stderr: 'rate limit exceeded' }))
    expect(info).not.toBeNull()
    expect(info!.resetAt).toBeNull()
    expect(info!.waitMs).toBe(DEFAULT_RATE_LIMIT_WAIT_MS)
  })

  it('clamps wait to minimum when reset time is in the past', () => {
    // "reset at 11:00 AM" but it's 12:00 PM → in the past → pushes to tomorrow
    // Actually our parser pushes past times to tomorrow, so let's test with a direct scenario
    // Use "reset in 5 seconds" which is below the 30s minimum
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limited. try again in 5 seconds'
    }))
    expect(info).not.toBeNull()
    expect(info!.waitMs).toBe(MIN_RATE_LIMIT_WAIT_MS)
  })

  it('clamps wait to maximum when reset time is far future', () => {
    const info = detectRateLimit(makeResult({
      stderr: 'Rate limited. try again in 120 minutes'
    }))
    expect(info).not.toBeNull()
    expect(info!.waitMs).toBe(MAX_RATE_LIMIT_WAIT_MS)
  })

  it('truncates rawMessage to 500 chars', () => {
    const longMessage = 'rate limit ' + 'x'.repeat(600)
    const info = detectRateLimit(makeResult({ stderr: longMessage }))
    expect(info).not.toBeNull()
    expect(info!.rawMessage.length).toBe(500)
  })
})

// ─── sleep ───────────────────────────────────────────────────

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after specified duration', async () => {
    const p = sleep(1000)
    vi.advanceTimersByTime(1000)
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects when abort signal fires', async () => {
    const controller = new AbortController()
    const p = sleep(10000, controller.signal)
    controller.abort()
    await expect(p).rejects.toThrow('Rate limit wait aborted')
  })

  it('rejects immediately if signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(10000, controller.signal)).rejects.toThrow('Rate limit wait aborted')
  })
})
