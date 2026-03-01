/**
 * Tests for Windows-specific helpers in server/index.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let windowsQuote: (arg: string) => string
let shellQuote: (arg: string) => string
let isLoopbackAddress: (address: string | undefined) => boolean
let createCloudReadyUpdateHandler: (triggerShutdown: () => void) => (version: string) => void

// The server index has heavy side-effects. We import only the test-exported helpers
// by mocking out every heavy dependency to prevent the module from initializing
// database connections or starting servers.

beforeEach(async () => {
  vi.resetModules()

  // Stub heavy dependencies so the module loads without side effects
  vi.doMock('better-sqlite3', () => ({ default: vi.fn() }))
  vi.doMock('../../shared/db-queries', () => ({}))
  vi.doMock('../../shared/db-schema', () => ({ initDatabase: vi.fn() }))
  vi.doMock('../ws', () => ({ createWebSocketServer: vi.fn() }))
  vi.doMock('../router', () => ({ Router: vi.fn(() => ({ add: vi.fn(), match: vi.fn() })) }))
  vi.doMock('../auth', () => ({ generateToken: vi.fn(), getTokenPrincipal: vi.fn(), isAllowedOrigin: vi.fn() }))
  vi.doMock('../event-bus', () => ({ eventBus: { emit: vi.fn(), on: vi.fn() } }))

  const mod = await import('../index')
  windowsQuote = mod._windowsQuote
  shellQuote = mod._shellQuote
  isLoopbackAddress = mod._isLoopbackAddress
  createCloudReadyUpdateHandler = mod._createCloudReadyUpdateHandler
})

describe('windowsQuote', () => {
  it('wraps argument in double quotes', () => {
    expect(windowsQuote('hello')).toBe('"hello"')
  })

  it('escapes internal double quotes', () => {
    expect(windowsQuote('say "hello"')).toBe('"say \\"hello\\""')
  })

  it('handles empty string', () => {
    expect(windowsQuote('')).toBe('""')
  })

  it('handles path with spaces', () => {
    expect(windowsQuote('C:\\Program Files\\Quoroom\\node.exe')).toBe('"C:\\Program Files\\Quoroom\\node.exe"')
  })

  it('handles path with backslashes (does not double-escape)', () => {
    const result = windowsQuote('C:\\Users\\test')
    expect(result).toBe('"C:\\Users\\test"')
    expect(result).not.toContain('\\\\')
  })
})

describe('shellQuote', () => {
  it('wraps argument in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('escapes internal single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', () => {
    expect(shellQuote('')).toBe("''")
  })
})

describe('isLoopbackAddress', () => {
  it('returns true for 127.0.0.1', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
  })

  it('returns true for ::1', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
  })

  it('returns true for ::ffff:127.0.0.1', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('returns false for external addresses', () => {
    expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('createCloudReadyUpdateHandler', () => {
  it('triggers shutdown only once even when called multiple times', async () => {
    vi.useFakeTimers()
    try {
      const shutdown = vi.fn()
      const onReady = createCloudReadyUpdateHandler(shutdown)
      onReady('1.2.3')
      onReady('1.2.3')
      onReady('1.2.4')

      expect(shutdown).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120)
      expect(shutdown).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
