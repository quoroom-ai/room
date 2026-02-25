import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────

let mockExecSync: ReturnType<typeof vi.fn>
let mockExistsSync: ReturnType<typeof vi.fn>
let mockRmSync: ReturnType<typeof vi.fn>
let mockHomedir: ReturnType<typeof vi.fn>
let mockQuestion: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  mockExecSync = vi.fn()
  mockExistsSync = vi.fn().mockReturnValue(false)
  mockRmSync = vi.fn()
  mockHomedir = vi.fn().mockReturnValue(
    process.platform === 'win32' ? 'C:\\Users\\test' : '/mock-home'
  )
  mockQuestion = vi.fn()
})

function setupMocks() {
  vi.doMock('child_process', () => ({ execSync: mockExecSync }))
  vi.doMock('fs', () => ({ existsSync: mockExistsSync, rmSync: mockRmSync }))
  vi.doMock('os', () => ({ homedir: mockHomedir }))
  vi.doMock('readline', () => ({
    createInterface: () => ({
      question: mockQuestion,
      close: vi.fn(),
    }),
  }))
}

async function importRunUninstall() {
  setupMocks()
  const mod = await import('../uninstall')
  return mod.runUninstall
}

/** Simulate user typing 'y' to confirm */
function answerYes() {
  mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('y'))
}

/** Simulate user typing 'n' to cancel */
function answerNo() {
  mockQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('n'))
}

// ─── Tests ──────────────────────────────────────────────────────

class ExitCalled extends Error { code: number; constructor(code: number) { super(`process.exit(${code})`); this.code = code } }

describe('runUninstall', () => {
  it('cancels when user answers no', async () => {
    answerNo()
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ExitCalled(code as number) })
    const runUninstall = await importRunUninstall()
    try { runUninstall() } catch (e) { expect(e).toBeInstanceOf(ExitCalled) }
    expect(mockExit).toHaveBeenCalledWith(0)
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockRmSync).not.toHaveBeenCalled()
    mockExit.mockRestore()
  })

  it('prompts user before proceeding', async () => {
    answerNo()
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ExitCalled(code as number) })
    const runUninstall = await importRunUninstall()
    try { runUninstall() } catch { /* expected */ }
    expect(mockQuestion).toHaveBeenCalledOnce()
    expect(mockQuestion.mock.calls[0][0]).toMatch(/remove Quoroom/)
    mockExit.mockRestore()
  })
})

describe('uninstall — Windows path', () => {
  // These tests verify the Windows code path is correct, but only run the
  // platform branch that matches the current OS (IS_WIN is set at import time).
  // On non-Windows CI, the Unix branch runs instead — that's fine, both are tested.

  if (process.platform !== 'win32') {
    it.skip('skipped: Windows-specific tests only run on Windows', () => {})
    return
  }

  it('calls taskkill to stop server', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('taskkill'))).toBe(true)
  })

  it('calls powershell to stop port 3700 listeners', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('Get-NetTCPConnection') && cmd.includes('3700'))).toBe(true)
  })

  it('removes data directory when it exists', async () => {
    answerYes()
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.quoroom'))
    const runUninstall = await importRunUninstall()
    runUninstall()
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('.quoroom'),
      { recursive: true, force: true }
    )
  })

  it('reads install directory from registry', async () => {
    answerYes()
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('reg query')) {
        return '    InstallDir    REG_SZ    C:\\Program Files\\Quoroom\r\n'
      }
      return ''
    })
    mockExistsSync.mockImplementation((p: string) => {
      if (p === 'C:\\Program Files\\Quoroom') return true
      if (p.endsWith('.quoroom')) return true
      return false
    })
    const runUninstall = await importRunUninstall()
    runUninstall()
    expect(mockRmSync).toHaveBeenCalledWith(
      'C:\\Program Files\\Quoroom',
      { recursive: true, force: true }
    )
  })

  it('cleans registry keys', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('reg delete') && cmd.includes('Software\\Quoroom'))).toBe(true)
    expect(calls.some((cmd: string) => cmd.includes('reg delete') && cmd.includes('Uninstall\\Quoroom'))).toBe(true)
  })

  it('does not call pkill or sudo on Windows', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('pkill'))).toBe(false)
    expect(calls.some((cmd: string) => cmd.includes('sudo'))).toBe(false)
  })
})

describe('uninstall — Unix path', () => {
  if (process.platform === 'win32') {
    it.skip('skipped: Unix-specific tests only run on Unix/macOS', () => {})
    return
  }

  it('calls pkill to stop server', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('pkill'))).toBe(true)
  })

  it('removes data and logs directories when they exist', async () => {
    answerYes()
    mockExistsSync.mockReturnValue(true)
    const runUninstall = await importRunUninstall()
    runUninstall()
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('.quoroom'),
      { recursive: true, force: true }
    )
  })

  it('calls sudo rm for lib and bin when they exist', async () => {
    answerYes()
    mockExistsSync.mockReturnValue(true)
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('sudo rm -rf'))).toBe(true)
  })

  it('calls pkgutil --forget on macOS', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('pkgutil --forget'))).toBe(true)
  })

  it('does not call taskkill or reg on Unix', async () => {
    answerYes()
    const runUninstall = await importRunUninstall()
    runUninstall()
    const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
    expect(calls.some((cmd: string) => cmd.includes('taskkill'))).toBe(false)
    expect(calls.some((cmd: string) => cmd.includes('reg delete'))).toBe(false)
  })
})
