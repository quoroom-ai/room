import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ConsoleLogEvent {
  entryType: 'tool_call' | 'assistant_text' | 'tool_result' | 'result' | 'error'
  content: string
}

export type ConsoleLogCallback = (entry: ConsoleLogEvent) => void

export interface ExecutionOptions {
  timeoutMs?: number
  maxTurns?: number
  allowedTools?: string
  disallowedTools?: string
  onProgress?: ProgressCallback
  onConsoleLog?: ConsoleLogCallback
  resumeSessionId?: string
  systemPrompt?: string
  model?: string
}

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  sessionId: string | null
}

export interface ProgressUpdate {
  fraction: number | null  // 0.0 to 1.0 if estimable, null = indeterminate
  message: string
}

export type ProgressCallback = (progress: ProgressUpdate) => void

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

let cachedClaudePath: string | null = null

/**
 * Resolve the full path to the `claude` CLI binary.
 * Packaged Electron apps don't inherit the user's login shell PATH,
 * so we probe common locations and fall back to a login-shell `which`.
 */
function resolveClaudePath(): string | null {
  if (cachedClaudePath) return cachedClaudePath

  const home = homedir()
  const isWindows = process.platform === 'win32'

  const candidates: string[] = isWindows
    ? [
        join(home, '.claude', 'bin', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Programs', 'claude-code', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Claude', 'claude.exe'),
        join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
        'C:\\Program Files\\Claude\\claude.exe'
      ]
    : [
        join(home, '.local', 'bin', 'claude'),
        join(home, '.claude', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/snap/bin/claude',
        '/opt/homebrew/bin/claude'
      ]

  for (const p of candidates) {
    if (existsSync(p)) {
      cachedClaudePath = p
      return p
    }
  }

  // Fall back to shell resolution
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  if (isWindows) {
    // Use 'where' on Windows (equivalent of 'which')
    try {
      const resolved = execSync('where claude', {
        encoding: 'utf-8',
        env,
        timeout: 5000
      }).trim().split('\n')[0].trim()
      if (resolved && existsSync(resolved)) {
        cachedClaudePath = resolved
        return resolved
      }
    } catch { /* not in PATH */ }
  } else {
    // Unix: try login shell resolution (works when PATH is set in .zshrc / .bashrc)
    const shells = ['/bin/zsh', '/bin/bash']
    for (const sh of shells) {
      if (!existsSync(sh)) continue
      try {
        const resolved = execSync(`${sh} -l -c 'which claude'`, {
          encoding: 'utf-8',
          env,
          timeout: 5000
        }).trim()
        if (resolved && existsSync(resolved)) {
          cachedClaudePath = resolved
          return resolved
        }
      } catch {
        // Shell not available or claude not in that shell's PATH
      }
    }
  }

  return null
}

export function checkClaudeCliAvailable(): { available: boolean; version?: string; error?: string } {
  try {
    const claudePath = resolveClaudePath()
    if (!claudePath) {
      return { available: false, error: 'Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code' }
    }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const version = execSync(`"${claudePath}" --version`, { encoding: 'utf-8', env, timeout: 5000 }).trim()
    return { available: true, version }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return { available: false, error: 'Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code' }
    }
    return { available: false, error: msg }
  }
}

export function executeClaudeCode(
  prompt: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const onProgress = options?.onProgress

  return new Promise((resolve) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let lastResultText = ''
    let capturedSessionId: string | null = null

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE

    // Always use stream-json to capture session_id from result events
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    if (options?.resumeSessionId) {
      args.push('--resume', options.resumeSessionId)
    }
    if (options?.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt)
    }
    if (options?.model) {
      args.push('--model', options.model)
    }
    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (options?.allowedTools) {
      args.push('--allowedTools', options.allowedTools)
    }
    if (options?.disallowedTools) {
      args.push('--disallowedTools', options.disallowedTools)
    }

    const claudePath = resolveClaudePath()
    if (!claudePath) {
      resolve({
        stdout: '',
        stderr: 'Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code',
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        sessionId: null
      })
      return
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(claudePath, args, {
        cwd: homedir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: `Failed to spawn Claude CLI: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        sessionId: null
      })
      return
    }

    // Guard against failed pipe creation (fd exhaustion)
    if (!proc.stdout || !proc.stderr) {
      resolve({
        stdout: '',
        stderr: 'Failed to create stdio pipes for Claude CLI (bad file descriptor)',
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        sessionId: null
      })
      try { proc.kill() } catch {}
      return
    }

    let buffer = ''
    let toolCallCount = 0
    const onConsoleLog = options?.onConsoleLog

    function truncate(text: string, maxLen: number): string {
      return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stdout += chunk
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const type = event.type as string | undefined

          // CLI format: {"type":"assistant","message":{"content":[...]}}
          if (type === 'assistant') {
            const message = event.message as Record<string, unknown> | undefined
            const content = message?.content as Array<Record<string, unknown>> | undefined
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  onConsoleLog?.({ entryType: 'assistant_text', content: truncate(block.text, 2000) })
                } else if (block.type === 'tool_use') {
                  toolCallCount++
                  const toolName = (block.name as string) ?? 'tool'
                  onConsoleLog?.({ entryType: 'tool_call', content: `Step ${toolCallCount}: Using ${toolName}` })
                  onProgress?.({ fraction: null, message: `Step ${toolCallCount}: Using ${toolName}...` })
                } else if (block.type === 'tool_result') {
                  const resultContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
                  onConsoleLog?.({ entryType: 'tool_result', content: truncate(resultContent, 500) })
                }
              }
            }
          }

          // Capture session_id and result from result event
          if (type === 'result') {
            if (event.result) lastResultText = event.result
            if (event.session_id) capturedSessionId = event.session_id as string
            onConsoleLog?.({ entryType: 'result', content: truncate(String(event.result ?? ''), 2000) })
            onProgress?.({ fraction: 1.0, message: 'Completed' })
          }
        } catch {
          // Not valid JSON line, skip
        }
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 5000)
      }
    }, timeoutMs)

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: lastResultText ? lastResultText.trim() : stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        durationMs: Date.now() - startTime,
        timedOut,
        sessionId: capturedSessionId
      })
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const isNotFound = err.code === 'ENOENT'
      resolve({
        stdout: '',
        stderr: isNotFound
          ? 'Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code'
          : `Failed to spawn claude CLI: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        sessionId: null
      })
    })
  })
}

export interface ParsedProgress {
  fraction: number | null
  message: string
  isToolUse: boolean
}

export function parseStreamEvent(event: Record<string, unknown>, toolCallCount: number): ParsedProgress | null {
  const type = event.type as string | undefined

  // CLI format: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash",...}]}}
  if (type === 'assistant') {
    const message = event.message as Record<string, unknown> | undefined
    const content = message?.content as Array<Record<string, unknown>> | undefined
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolName = (block.name as string) ?? 'tool'
          return {
            fraction: null,
            message: `Step ${toolCallCount + 1}: Using ${toolName}...`,
            isToolUse: true
          }
        }
      }
    }
  }

  if (type === 'result') {
    return {
      fraction: 1.0,
      message: 'Completed',
      isToolUse: false
    }
  }

  return null
}
