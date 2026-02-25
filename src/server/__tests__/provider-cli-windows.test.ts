import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockExecFileSync: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  mockExecFileSync = vi.fn()
})

async function importModule() {
  vi.doMock('node:child_process', () => ({
    execFileSync: mockExecFileSync,
  }))
  return import('../provider-cli')
}

describe('getProviderCliCommand — Windows', () => {
  it('returns .cmd suffix for win32', async () => {
    const { getProviderCliCommand } = await importModule()
    expect(getProviderCliCommand('claude', 'win32')).toBe('claude.cmd')
    expect(getProviderCliCommand('codex', 'win32')).toBe('codex.cmd')
  })

  it('returns plain name for non-Windows', async () => {
    const { getProviderCliCommand } = await importModule()
    expect(getProviderCliCommand('claude', 'darwin')).toBe('claude')
    expect(getProviderCliCommand('codex', 'linux')).toBe('codex')
  })
})

describe('safeExec — Windows behavior', () => {
  if (process.platform === 'win32') {
    it('passes shell:true on Windows', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('1.0.0'))
      const { safeExec } = await importModule()
      safeExec('claude.cmd', ['--version'])
      const opts = mockExecFileSync.mock.calls[0][2] as Record<string, unknown>
      expect(opts.shell).toBe(true)
    })
  }

  if (process.platform !== 'win32') {
    it('does not pass shell:true on Unix', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('1.0.0'))
      const { safeExec } = await importModule()
      safeExec('claude', ['--version'])
      const opts = mockExecFileSync.mock.calls[0][2] as Record<string, unknown>
      expect(opts.shell).toBeUndefined()
    })
  }

  it('returns ok:true on success', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('2.5.0'))
    const { safeExec } = await importModule()
    const result = safeExec('claude.cmd', ['--version'])
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('2.5.0')
  })

  it('returns ok:false on error', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const { safeExec } = await importModule()
    const result = safeExec('nonexistent.cmd', ['--version'])
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('ENOENT')
  })
})

describe('probeProviderInstalled — Windows', () => {
  if (process.platform === 'win32') {
    it('uses .cmd command on Windows', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('1.0.0'))
      const { probeProviderInstalled } = await importModule()
      probeProviderInstalled('claude')
      expect(mockExecFileSync.mock.calls[0][0]).toBe('claude.cmd')
    })
  }
})
