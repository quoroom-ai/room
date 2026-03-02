import { describe, expect, it, vi } from 'vitest'
import { restartToApplyUpdate } from '../lib/update-restart'

function createDeterministicClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
  let current = 0
  return {
    now: () => current,
    wait: async (ms: number) => {
      current += ms
    },
  }
}

describe('restartToApplyUpdate', () => {
  it('restarts and reloads when polled version reaches target', async () => {
    const reload = vi.fn()
    const clock = createDeterministicClock()
    let calls = 0
    const fetchSpy = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('', { status: 202 })
      if (calls === 2) {
        return new Response(JSON.stringify({ version: '0.1.40' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ version: '0.1.41' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const fetchImpl = fetchSpy as unknown as typeof fetch

    const result = await restartToApplyUpdate({
      apiBase: 'http://localhost:3700',
      targetVersion: '0.1.41',
      authToken: 'test-token',
      fetchImpl,
      reload,
      now: clock.now,
      wait: clock.wait,
      requestTimeoutMs: 0,
      statusRequestTimeoutMs: 0,
      initialPollDelayMs: 0,
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    })

    expect(result).toEqual({ ok: true, reloaded: true, reason: 'updated' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const secondCallInit = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined
    const secondCallHeaders = secondCallInit?.headers as Record<string, string> | undefined
    expect(secondCallHeaders?.Authorization).toBe('Bearer test-token')
  })

  it('continues polling when restart request drops and then reloads on recovery', async () => {
    const reload = vi.fn()
    const clock = createDeterministicClock()
    let calls = 0
    const fetchSpy = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        const abort = new Error('aborted')
        abort.name = 'AbortError'
        throw abort
      }
      if (calls === 2) {
        throw new TypeError('Failed to fetch')
      }
      return new Response(JSON.stringify({ version: '0.1.41' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const fetchImpl = fetchSpy as unknown as typeof fetch

    const result = await restartToApplyUpdate({
      apiBase: 'http://localhost:3700',
      targetVersion: '0.1.41',
      authToken: 'test-token',
      fetchImpl,
      reload,
      now: clock.now,
      wait: clock.wait,
      requestTimeoutMs: 0,
      statusRequestTimeoutMs: 0,
      initialPollDelayMs: 0,
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    })

    expect(result).toEqual({ ok: true, reloaded: true, reason: 'updated' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('returns an explicit error for hard HTTP failures on update-restart', async () => {
    const reload = vi.fn()
    const clock = createDeterministicClock()
    const fetchSpy = vi.fn(async () => (
      new Response(JSON.stringify({ error: 'No update ready to apply' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    ))
    const fetchImpl = fetchSpy as unknown as typeof fetch

    const result = await restartToApplyUpdate({
      apiBase: 'http://localhost:3700',
      targetVersion: '0.1.41',
      fetchImpl,
      reload,
      now: clock.now,
      wait: clock.wait,
      requestTimeoutMs: 0,
      statusRequestTimeoutMs: 0,
      initialPollDelayMs: 0,
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Expected a failed result')
    expect(result.error).toContain('No update ready to apply')
    expect(reload).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to reload after bounded polling timeout', async () => {
    const reload = vi.fn()
    const clock = createDeterministicClock()
    let calls = 0
    const fetchSpy = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('', { status: 202 })
      return new Response(JSON.stringify({ version: '0.1.40' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const fetchImpl = fetchSpy as unknown as typeof fetch

    const result = await restartToApplyUpdate({
      apiBase: 'http://localhost:3700',
      targetVersion: '0.1.41',
      authToken: 'test-token',
      fetchImpl,
      reload,
      now: clock.now,
      wait: clock.wait,
      requestTimeoutMs: 0,
      statusRequestTimeoutMs: 0,
      initialPollDelayMs: 0,
      pollIntervalMs: 2,
      pollTimeoutMs: 5,
    })

    expect(result).toEqual({ ok: true, reloaded: true, reason: 'fallback_timeout' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })
})
