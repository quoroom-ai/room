import { describe, it, expect } from 'vitest'
import { extractProviderAuthHints } from '../provider-auth'
import { getNpmCommand, getProviderInstallCommand } from '../provider-install'

describe('extractProviderAuthHints', () => {
  it('extracts verification URL and device code', () => {
    const input = 'Open https://auth.openai.com/device and enter code: abcd-1234'
    const hints = extractProviderAuthHints(input)
    expect(hints.verificationUrl).toBe('https://auth.openai.com/device')
    expect(hints.deviceCode).toBe('ABCD-1234')
  })

  it('extracts device code from variant phrasing', () => {
    const input = 'Your verification code is ZXCV-7788. Continue in browser.'
    const hints = extractProviderAuthHints(input)
    expect(hints.verificationUrl).toBeNull()
    expect(hints.deviceCode).toBe('ZXCV-7788')
  })

  it('returns null hints when no auth hints are present', () => {
    const hints = extractProviderAuthHints('Login started, waiting for completion...')
    expect(hints.verificationUrl).toBeNull()
    expect(hints.deviceCode).toBeNull()
  })
})

describe('provider install command selection', () => {
  it('uses npm command per platform', () => {
    expect(getNpmCommand('linux')).toBe('npm')
    expect(getNpmCommand('darwin')).toBe('npm')
    expect(getNpmCommand('win32')).toBe('npm.cmd')
  })

  it('builds codex and claude install commands', () => {
    expect(getProviderInstallCommand('codex', 'linux')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@openai/codex'],
    })
    expect(getProviderInstallCommand('claude', 'linux')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code'],
    })
  })
})
