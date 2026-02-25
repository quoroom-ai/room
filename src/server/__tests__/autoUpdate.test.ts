import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockExecSync: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  mockExecSync = vi.fn()
})

async function importExtractTarGz() {
  vi.doMock('node:child_process', () => ({ execSync: mockExecSync }))
  const mod = await import('../autoUpdate')
  return mod.extractTarGz
}

describe('extractTarGz', () => {
  it('calls tar with correct arguments', async () => {
    mockExecSync.mockReturnValue(undefined)
    const extractTarGz = await importExtractTarGz()
    await extractTarGz('/path/to/bundle.tar.gz', '/dest/dir')
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('tar xzf'),
      { stdio: 'ignore' }
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('bundle.tar.gz'),
      expect.anything()
    )
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('/dest/dir'),
      expect.anything()
    )
  })

  it('throws descriptive error when tar fails on Windows', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('tar: command not found')
    })
    // Temporarily override platform for this test
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const extractTarGz = await importExtractTarGz()
      await expect(extractTarGz('/path/to/bundle.tar.gz', '/dest'))
        .rejects.toThrow('Failed to extract update bundle')
      await expect(extractTarGz('/path/to/bundle.tar.gz', '/dest'))
        .rejects.toThrow('Ensure Windows 10 build 17063+')
    } finally {
      if (origPlatform) {
        Object.defineProperty(process, 'platform', origPlatform)
      }
    }
  })

  it('throws descriptive error when tar fails on Unix', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('tar: exec format error')
    })
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const extractTarGz = await importExtractTarGz()
      await expect(extractTarGz('/path/to/bundle.tar.gz', '/dest'))
        .rejects.toThrow('System tar command failed')
    } finally {
      if (origPlatform) {
        Object.defineProperty(process, 'platform', origPlatform)
      }
    }
  })

  it('includes original error message in thrown error', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    const extractTarGz = await importExtractTarGz()
    await expect(extractTarGz('/path/to/bundle.tar.gz', '/dest'))
      .rejects.toThrow('ENOENT: no such file')
  })

  it('does not throw when tar succeeds', async () => {
    mockExecSync.mockReturnValue(undefined)
    const extractTarGz = await importExtractTarGz()
    await expect(extractTarGz('/path/to/bundle.tar.gz', '/dest'))
      .resolves.toBeUndefined()
  })

  it('quotes paths with JSON.stringify for safety', async () => {
    mockExecSync.mockReturnValue(undefined)
    const extractTarGz = await importExtractTarGz()
    await extractTarGz('/path/with spaces/file.tar.gz', '/dest with spaces')
    const cmd = mockExecSync.mock.calls[0][0] as string
    // JSON.stringify wraps paths in double quotes
    expect(cmd).toContain('"/path/with spaces/file.tar.gz"')
    expect(cmd).toContain('"/dest with spaces"')
  })
})
