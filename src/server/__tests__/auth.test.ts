import { describe, it, expect, beforeEach } from 'vitest'
import {
  generateToken,
  getToken,
  getUserToken,
  setToken,
  setUserToken,
  validateToken,
  isAllowedOrigin,
  isLocalOrigin,
  setCorsHeaders
} from '../auth'

beforeEach(() => {
  generateToken()
})

describe('generateToken / getToken', () => {
  it('generates a 64-char hex token', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('getToken returns the current token', () => {
    const token = generateToken()
    expect(getToken()).toBe(token)
  })

  it('setToken overrides the token', () => {
    setToken('custom-token-value')
    expect(getToken()).toBe('custom-token-value')
  })
})

describe('dual tokens', () => {
  it('generates separate agent and user tokens', () => {
    generateToken()
    expect(getToken()).not.toBe(getUserToken())
    expect(getToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(getUserToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('setUserToken overrides the user token', () => {
    generateToken()
    setUserToken('custom-user-token-value')
    expect(getUserToken()).toBe('custom-user-token-value')
  })
})

describe('validateToken', () => {
  it('returns agent role for agent token', () => {
    const agentToken = generateToken()
    expect(validateToken(`Bearer ${agentToken}`)).toBe('agent')
  })

  it('returns user role for user token', () => {
    generateToken()
    const userToken = getUserToken()
    expect(validateToken(`Bearer ${userToken}`)).toBe('user')
  })

  it('rejects missing header', () => {
    expect(validateToken(undefined)).toBeNull()
  })

  it('rejects wrong prefix', () => {
    const token = generateToken()
    expect(validateToken(`Basic ${token}`)).toBeNull()
  })

  it('rejects wrong token', () => {
    generateToken()
    expect(validateToken('Bearer wrong-token-000000000000000000000000000000000000000000000000000000')).toBeNull()
  })

  it('handles short tokens without crashing', () => {
    generateToken()
    expect(() => validateToken('Bearer short')).not.toThrow()
    expect(validateToken('Bearer short')).toBeNull()
  })
})

describe('isAllowedOrigin', () => {
  it('allows no origin (same-origin requests)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
  })

  it('allows localhost', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true)
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://localhost:3700')).toBe(true)
  })

  it('allows 127.0.0.1', () => {
    expect(isAllowedOrigin('http://127.0.0.1')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(true)
  })

  it('rejects external origins', () => {
    expect(isAllowedOrigin('http://example.com')).toBe(false)
    expect(isAllowedOrigin('http://evil.localhost.com')).toBe(false)
    expect(isAllowedOrigin('https://attacker.io')).toBe(false)
  })

  it('rejects invalid origins', () => {
    expect(isAllowedOrigin('not-a-url')).toBe(false)
  })
})

describe('isLocalOrigin', () => {
  it('allows same-origin requests without Origin header', () => {
    expect(isLocalOrigin(undefined)).toBe(true)
  })

  it('allows localhost only', () => {
    expect(isLocalOrigin('http://localhost')).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:3700')).toBe(true)
    expect(isLocalOrigin('https://app.quoroom.ai')).toBe(false)
    expect(isLocalOrigin('http://example.com')).toBe(false)
  })
})

describe('setCorsHeaders', () => {
  it('sets CORS headers with allowed origin', () => {
    const headers: Record<string, string> = {}
    setCorsHeaders('http://localhost:3000', headers)

    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(headers['Access-Control-Allow-Methods']).toContain('GET')
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization')
    expect(headers['Access-Control-Max-Age']).toBe('86400')
  })

  it('does not set Allow-Origin for disallowed origin', () => {
    const headers: Record<string, string> = {}
    setCorsHeaders('http://evil.com', headers)

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    // Other CORS headers are still set
    expect(headers['Access-Control-Allow-Methods']).toBeDefined()
  })

  it('does not set Allow-Origin when no origin', () => {
    const headers: Record<string, string> = {}
    setCorsHeaders(undefined, headers)

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})
