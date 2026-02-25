import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

let mockExecFileSync: ReturnType<typeof vi.fn>
let mockExecSync: ReturnType<typeof vi.fn>
let mockExistsSync: ReturnType<typeof vi.fn>
let savedPath: string | undefined

beforeEach(() => {
  vi.resetModules()
  mockExecFileSync = vi.fn()
  mockExecSync = vi.fn()
  mockExistsSync = vi.fn().mockReturnValue(true)
  savedPath = process.env.PATH
})

afterEach(() => {
  process.env.PATH = savedPath
})

async function importModule() {
  vi.doMock('node:child_process', () => ({
    execFileSync: mockExecFileSync,
    execSync: mockExecSync,
  }))
  vi.doMock('node:fs', () => ({
    existsSync: mockExistsSync,
  }))
  return import('../shell-path')
}

describe('inheritShellPath — Windows', () => {
  if (process.platform === 'win32') {
    it('calls npm.cmd to get global prefix', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('C:\\Users\\test\\AppData\\Roaming\\npm'))
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'npm.cmd',
        ['prefix', '-g'],
        expect.objectContaining({ shell: true })
      )
    })

    it('adds npm prefix directly to PATH (no /bin subdirectory on Windows)', async () => {
      const npmPrefix = 'C:\\Users\\test\\AppData\\Roaming\\npm'
      mockExecFileSync.mockReturnValue(Buffer.from(npmPrefix))
      process.env.PATH = 'C:\\Windows\\system32'
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      expect(process.env.PATH).toContain(npmPrefix)
      // Should NOT contain npmPrefix + \\bin
      expect(process.env.PATH).not.toContain(path.join(npmPrefix, 'bin'))
    })

    it('does not duplicate if npm prefix already in PATH', async () => {
      const npmPrefix = 'C:\\Users\\test\\AppData\\Roaming\\npm'
      mockExecFileSync.mockReturnValue(Buffer.from(npmPrefix))
      process.env.PATH = `${npmPrefix};C:\\Windows\\system32`
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      // Count occurrences of npmPrefix — should be exactly 1
      const parts = (process.env.PATH || '').split(path.delimiter)
      expect(parts.filter(p => p === npmPrefix).length).toBe(1)
    })

    it('handles npm failure gracefully', async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('npm not found') })
      const originalPath = process.env.PATH
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      expect(process.env.PATH).toBe(originalPath)
    })

    it('does not call Unix shell resolution on Windows', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('C:\\npm'))
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      // Should NOT call execSync with /bin/zsh or /bin/bash
      expect(mockExecSync).not.toHaveBeenCalled()
    })
  }

  if (process.platform !== 'win32') {
    it('uses npm (not npm.cmd) on Unix', async () => {
      // On Linux, inheritShellPath delegates to inheritWindowsPath (npm global enrichment)
      // On macOS, it tries shell PATH first, then falls through
      mockExecFileSync.mockReturnValue(Buffer.from('/usr/local'))
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      if (process.platform === 'linux') {
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'npm',
          ['prefix', '-g'],
          expect.objectContaining({ shell: false })
        )
      }
    })

    it('adds prefix/bin to PATH on Unix', async () => {
      if (process.platform !== 'linux') return // Darwin uses shell PATH
      mockExecFileSync.mockReturnValue(Buffer.from('/usr/local'))
      process.env.PATH = '/usr/bin'
      const { inheritShellPath } = await importModule()
      inheritShellPath()
      expect(process.env.PATH).toContain('/usr/local/bin')
    })
  }
})
