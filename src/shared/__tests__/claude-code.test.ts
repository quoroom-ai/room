import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'path'
import { parseStreamEvent } from '../claude-code'

// First candidate path for /mock-home on each platform
const MOCK_HOME = '/mock-home'
const MOCK_CLAUDE_PATH =
  process.platform === 'win32'
    ? join(MOCK_HOME, '.claude', 'bin', 'claude.exe')
    : join(MOCK_HOME, '.local', 'bin', 'claude')

// ─── parseStreamEvent ─────────────────────────────────────────

describe('parseStreamEvent', () => {
  it('returns tool_use progress for assistant message with tool_use', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] }
    }
    const result = parseStreamEvent(event, 0)
    expect(result).not.toBeNull()
    expect(result!.message).toBe('Step 1: Using Bash...')
    expect(result!.fraction).toBeNull()
    expect(result!.isToolUse).toBe(true)
  })

  it('increments step number based on toolCallCount', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit' }] }
    }
    const result = parseStreamEvent(event, 3)
    expect(result!.message).toBe('Step 4: Using Edit...')
  })

  it('uses "tool" as default name when name is missing', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use' }] }
    }
    const result = parseStreamEvent(event, 0)
    expect(result!.message).toBe('Step 1: Using tool...')
  })

  it('returns completed progress for result event', () => {
    const event = { type: 'result', result: 'Task done' }
    const result = parseStreamEvent(event, 5)
    expect(result).not.toBeNull()
    expect(result!.fraction).toBe(1.0)
    expect(result!.message).toBe('Completed')
    expect(result!.isToolUse).toBe(false)
  })

  it('returns null for assistant message with only text', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] }
    }
    expect(parseStreamEvent(event, 0)).toBeNull()
  })

  it('returns null for unrecognized event types', () => {
    expect(parseStreamEvent({ type: 'system' }, 0)).toBeNull()
    expect(parseStreamEvent({ type: 'message_start' }, 0)).toBeNull()
    expect(parseStreamEvent({}, 0)).toBeNull()
  })

  it('returns null for assistant message without content', () => {
    const event = { type: 'assistant', message: {} }
    expect(parseStreamEvent(event, 0)).toBeNull()
  })
})

// ─── checkClaudeCliAvailable ──────────────────────────────────

describe('checkClaudeCliAvailable', () => {
  let mockExecSync: ReturnType<typeof vi.fn>
  let mockExistsSync: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockExecSync = vi.fn()
    mockExistsSync = vi.fn().mockReturnValue(true)
  })

  async function importWithMock() {
    vi.doMock('child_process', () => ({
      execSync: mockExecSync,
      spawn: vi.fn()
    }))
    vi.doMock('fs', () => ({
      existsSync: mockExistsSync
    }))
    vi.doMock('os', () => ({
      homedir: () => '/mock-home'
    }))
    const mod = await import('../claude-code')
    return mod.checkClaudeCliAvailable
  }

  it('returns available with version when CLI is found', async () => {
    mockExecSync.mockReturnValue('1.0.5\n')
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(true)
    expect(result.version).toBe('1.0.5')
  })

  it('returns not available when claude binary not found on disk', async () => {
    mockExistsSync.mockReturnValue(false)
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(false)
    expect(result.error).toContain('Claude CLI not found')
  })

  it('returns not available with specific message for ENOENT', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('ENOENT: command not found') })
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(false)
    expect(result.error).toContain('Claude CLI not found')
  })

  it('returns not available with specific message for "not found"', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('claude: not found') })
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(false)
    expect(result.error).toContain('Claude CLI not found')
  })

  it('returns not available with error message for other errors', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('Permission denied') })
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(false)
    expect(result.error).toBe('Permission denied')
  })

  it('handles non-Error throws', async () => {
    mockExecSync.mockImplementation(() => { throw 'string error' })
    const checkClaudeCliAvailable = await importWithMock()
    const result = checkClaudeCliAvailable()
    expect(result.available).toBe(false)
    expect(result.error).toBe('string error')
  })

  it('deletes ELECTRON_RUN_AS_NODE from env', async () => {
    mockExecSync.mockReturnValue('1.0.0')
    const checkClaudeCliAvailable = await importWithMock()
    checkClaudeCliAvailable()
    const callArgs = mockExecSync.mock.calls[0]
    expect(callArgs[0]).toBe(`"${MOCK_CLAUDE_PATH}" --version`)
    const env = callArgs[1].env
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })
})

// ─── executeClaudeCode ────────────────────────────────────────

describe('executeClaudeCode', () => {
  let mockSpawn: ReturnType<typeof vi.fn>
  let mockExistsSync: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockSpawn = vi.fn()
    mockExistsSync = vi.fn().mockReturnValue(true)
  })

  function createMockProcess() {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    return proc
  }

  async function importWithMock() {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(),
      spawn: mockSpawn
    }))
    vi.doMock('fs', () => ({
      existsSync: mockExistsSync
    }))
    vi.doMock('os', () => ({
      homedir: () => '/mock-home'
    }))
    const mod = await import('../claude-code')
    return mod.executeClaudeCode
  }

  it('resolves with error when claude binary not found', async () => {
    mockExistsSync.mockReturnValue(false)
    const executeClaudeCode = await importWithMock()
    const result = await executeClaudeCode('Test')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Claude CLI not found')
    expect(result.sessionId).toBeNull()
  })

  it('resolves with result text from stream-json result event', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Say hello')

    // Simulate stream-json output
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"Hello world","session_id":"sess-1"}\n'))
    proc.emit('close', 0)

    const result = await promise
    expect(result.stdout).toBe('Hello world')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.sessionId).toBe('sess-1')
  })

  it('builds correct args with default options', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('My prompt')
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'))
    proc.emit('close', 0)
    await promise

    expect(mockSpawn).toHaveBeenCalledWith(
      MOCK_CLAUDE_PATH,
      ['-p', 'My prompt', '--output-format', 'stream-json', '--verbose'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
  })

  it('adds --resume flag when resumeSessionId is provided', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Continue', { resumeSessionId: 'sess-abc' })
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"continued"}\n'))
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1]
    expect(args).toContain('--resume')
    expect(args).toContain('sess-abc')
  })

  it('adds --system-prompt flag when systemPrompt is provided', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Do work', { systemPrompt: 'You are a bot.' })
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"done"}\n'))
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1]
    expect(args).toContain('--system-prompt')
    expect(args).toContain('You are a bot.')
  })

  it('handles non-zero exit code', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Fail')
    proc.stderr.emit('data', Buffer.from('Something went wrong'))
    proc.emit('close', 1)

    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('Something went wrong')
  })

  it('handles spawn ENOENT error', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    proc.emit('error', err)

    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Claude CLI not found')
    expect(result.sessionId).toBeNull()
  })

  it('handles spawn non-ENOENT error', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    const err = new Error('Permission denied') as NodeJS.ErrnoException
    err.code = 'EACCES'
    proc.emit('error', err)

    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Failed to spawn claude CLI')
    expect(result.stderr).toContain('Permission denied')
  })

  it('calls onProgress for tool use events', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const progressUpdates: Array<{ fraction: number | null; message: string }> = []
    const promise = executeClaudeCode('Do something', {
      onProgress: (p) => progressUpdates.push(p)
    })

    proc.stdout.emit('data', Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n'
    ))
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"done"}\n'))
    proc.emit('close', 0)

    await promise
    expect(progressUpdates.length).toBe(2)
    expect(progressUpdates[0].message).toBe('Step 1: Using Bash...')
    expect(progressUpdates[1].message).toBe('Completed')
  })

  it('captures session_id from result event', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"ok","session_id":"my-session-id"}\n'))
    proc.emit('close', 0)

    const result = await promise
    expect(result.sessionId).toBe('my-session-id')
  })

  it('returns null sessionId when not present in output', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.stdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'))
    proc.emit('close', 0)

    const result = await promise
    expect(result.sessionId).toBeNull()
  })

  it('handles null exit code as 1', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.emit('close', null)

    const result = await promise
    expect(result.exitCode).toBe(1)
  })

  it('removes ELECTRON_RUN_AS_NODE from env', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.emit('close', 0)
    await promise

    const env = mockSpawn.mock.calls[0][2].env
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('ignores non-JSON lines in stdout', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.stdout.emit('data', Buffer.from('not json at all\n{"type":"result","result":"ok"}\n'))
    proc.emit('close', 0)

    const result = await promise
    expect(result.stdout).toBe('ok')
  })

  it('handles null stdout/stderr (EBADF guard)', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
      kill: ReturnType<typeof vi.fn>
    }
    proc.stdout = null
    proc.stderr = null
    proc.kill = vi.fn()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const result = await executeClaudeCode('Test')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Failed to create stdio pipes')
    expect(result.sessionId).toBeNull()
    expect(proc.kill).toHaveBeenCalled()
  })

  it('does not pass timeout to spawn options (uses manual setTimeout instead)', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test', { timeoutMs: 5000 })
    proc.emit('close', 0)
    await promise

    expect(mockSpawn.mock.calls[0][2]).not.toHaveProperty('timeout')
  })

  it('handles spawn() throwing synchronously (e.g. EBADF)', async () => {
    const ebadfError = new Error('spawn EBADF') as NodeJS.ErrnoException
    ebadfError.code = 'EBADF'
    mockSpawn.mockImplementation(() => { throw ebadfError })
    const executeClaudeCode = await importWithMock()

    const result = await executeClaudeCode('Test')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Failed to spawn Claude CLI')
    expect(result.stderr).toContain('spawn EBADF')
    expect(result.sessionId).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('passes --max-turns flag when maxTurns is set', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test', { maxTurns: 25 })
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).toContain('--max-turns')
    expect(args).toContain('25')
  })

  it('does not pass --max-turns flag when maxTurns is not set', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).not.toContain('--max-turns')
  })

  it('passes --allowedTools flag when allowedTools is set', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test', { allowedTools: 'WebSearch,Read,Grep' })
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).toContain('--allowedTools')
    expect(args).toContain('WebSearch,Read,Grep')
  })

  it('passes --disallowedTools flag when disallowedTools is set', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test', { disallowedTools: 'WebFetch' })
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).toContain('--disallowedTools')
    expect(args).toContain('WebFetch')
  })

  it('does not pass tool restriction flags when not set', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    const executeClaudeCode = await importWithMock()

    const promise = executeClaudeCode('Test')
    proc.emit('close', 0)
    await promise

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--disallowedTools')
  })

  if (process.platform === 'win32') {
    it('spawns with shell:true on Windows when no .cmd node script resolved', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      // existsSync returns true for the claude path but readFileSync won't match .cmd pattern
      mockExistsSync.mockReturnValue(true)
      const executeClaudeCode = await importWithMock()

      const promise = executeClaudeCode('Test')
      proc.emit('close', 0)
      await promise

      const opts = mockSpawn.mock.calls[0][2]
      expect(opts.shell).toBe(true)
      expect(opts.windowsHide).toBe(true)
    })
  }

  if (process.platform !== 'win32') {
    it('spawns without shell:true on Unix', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      const executeClaudeCode = await importWithMock()

      const promise = executeClaudeCode('Test')
      proc.emit('close', 0)
      await promise

      const opts = mockSpawn.mock.calls[0][2]
      expect(opts.shell).toBeFalsy()
    })
  }
})

// ─── resolveNodeScript (Windows .cmd unwrapping) ─────────────

describe('resolveNodeScript', () => {
  let mockSpawn: ReturnType<typeof vi.fn>
  let mockReadFileSync: ReturnType<typeof vi.fn>
  let mockExistsSync: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockSpawn = vi.fn()
    mockReadFileSync = vi.fn()
    mockExistsSync = vi.fn()
  })

  function createProc() {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>
    }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    return proc
  }

  async function importModule() {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(),
      spawn: mockSpawn
    }))
    vi.doMock('fs', () => ({
      existsSync: mockExistsSync,
      readFileSync: mockReadFileSync,
    }))
    vi.doMock('os', () => ({
      homedir: () => 'C:\\Users\\test'
    }))
    const mod = await import('../claude-code')
    return mod
  }

  if (process.platform === 'win32') {
    it('extracts .js script path from npm .cmd wrapper and spawns node directly', async () => {
      const cmdPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'
      const jsPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'

      mockExistsSync.mockImplementation((p: string) => {
        if (p === cmdPath) return true
        if (p === jsPath) return true
        return false
      })

      mockReadFileSync.mockReturnValue(
        '@IF EXIST "%~dp0\\node.exe" (\r\n' +
        '  "%~dp0\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n' +
        ') ELSE (\r\n' +
        '  node "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n' +
        ')\r\n'
      )

      const proc = createProc()
      mockSpawn.mockReturnValue(proc)

      const mod = await importModule()
      const promise = mod.executeClaudeCode('Test')
      proc.emit('close', 0)
      await promise

      const spawnArgs = mockSpawn.mock.calls[0]
      expect(spawnArgs[0]).toBe(process.execPath)
      expect(spawnArgs[1][0]).toContain('cli.js')
    })

    it('falls back to shell:true when .cmd content has no dp0 pattern', async () => {
      const cmdPath = 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'

      mockExistsSync.mockImplementation((p: string) => p === cmdPath)
      mockReadFileSync.mockReturnValue('some random batch file content\r\n')

      const proc = createProc()
      mockSpawn.mockReturnValue(proc)

      const mod = await importModule()
      const promise = mod.executeClaudeCode('Test')
      proc.emit('close', 0)
      await promise

      const spawnArgs = mockSpawn.mock.calls[0]
      expect(spawnArgs[0]).toBe(cmdPath)
      expect(spawnArgs[2].shell).toBe(true)
    })
  }

  if (process.platform !== 'win32') {
    it('resolveNodeScript returns null on non-Windows (spawns claude directly)', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('')

      const proc = createProc()
      mockSpawn.mockReturnValue(proc)

      const mod = await importModule()
      const promise = mod.executeClaudeCode('Test')
      proc.emit('close', 0)
      await promise

      const spawnArgs = mockSpawn.mock.calls[0]
      expect(spawnArgs[0]).not.toBe(process.execPath)
      expect(spawnArgs[2].shell).toBeFalsy()
    })
  }
})

// ─── resolveClaudePath — Windows candidate paths ────────────

describe('resolveClaudePath — Windows candidates', () => {
  let mockExecSync: ReturnType<typeof vi.fn>
  let mockExistsSync: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockExecSync = vi.fn()
    mockExistsSync = vi.fn().mockReturnValue(false)
  })

  async function importWithMock(home: string) {
    vi.doMock('child_process', () => ({
      execSync: mockExecSync,
      spawn: vi.fn()
    }))
    vi.doMock('fs', () => ({
      existsSync: mockExistsSync,
      readFileSync: vi.fn().mockReturnValue(''),
    }))
    vi.doMock('os', () => ({
      homedir: () => home
    }))
    return (await import('../claude-code')).checkClaudeCliAvailable
  }

  if (process.platform === 'win32') {
    it('checks Windows candidate paths in order', async () => {
      mockExistsSync.mockReturnValue(false)
      const check = await importWithMock('C:\\Users\\test')
      check()
      // existsSync should have been called with Windows-specific paths
      const paths = mockExistsSync.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(paths.some((p: string) => p.includes('.claude\\bin\\claude.exe'))).toBe(true)
      expect(paths.some((p: string) => p.includes('AppData\\Local\\Programs'))).toBe(true)
      expect(paths.some((p: string) => p.includes('npm\\claude.cmd'))).toBe(true)
    })

    it('falls back to where command on Windows', async () => {
      mockExistsSync.mockReturnValue(false) // no candidates found on disk
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'where claude') return 'C:\\global\\claude.exe\n'
        throw new Error('unknown')
      })
      const check = await importWithMock('C:\\Users\\test')
      check()
      expect(mockExecSync).toHaveBeenCalledWith(
        'where claude',
        expect.objectContaining({ encoding: 'utf-8', timeout: 5000 })
      )
    })

    it('does not call Unix shell resolution on Windows', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecSync.mockImplementation(() => { throw new Error('not found') })
      const check = await importWithMock('C:\\Users\\test')
      check()
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(calls.some((cmd: string) => cmd.includes('/bin/zsh') || cmd.includes('/bin/bash'))).toBe(false)
    })
  }

  if (process.platform !== 'win32') {
    it('checks Unix candidate paths', async () => {
      mockExistsSync.mockReturnValue(false)
      const check = await importWithMock('/mock-home')
      check()
      const paths = mockExistsSync.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(paths.some((p: string) => p.includes('.local/bin/claude'))).toBe(true)
      expect(paths.some((p: string) => p === '/usr/local/bin/claude')).toBe(true)
    })

    it('does not check Windows paths or call where on Unix', async () => {
      mockExistsSync.mockReturnValue(false)
      mockExecSync.mockImplementation(() => { throw new Error('not found') })
      const check = await importWithMock('/mock-home')
      check()
      const paths = mockExistsSync.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(paths.some((p: string) => p.includes('AppData'))).toBe(false)
      const cmds = mockExecSync.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(cmds.some((cmd: string) => cmd.includes('where'))).toBe(false)
    })
  }
})
