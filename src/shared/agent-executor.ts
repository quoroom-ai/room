import http from 'http'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { executeClaudeCode } from './claude-code'
import type { ExecutionOptions, ExecutionResult, ConsoleLogCallback, ProgressCallback } from './claude-code'
import { execOnCloudStation } from './cloud-sync'

export interface AgentExecutionOptions {
  model: string // 'claude' | 'codex' | 'openai:gpt-4o-mini' | 'anthropic:claude-3-5-sonnet-latest' | 'ollama:llama3'
  prompt: string
  systemPrompt?: string
  maxTurns?: number
  timeoutMs?: number
  resumeSessionId?: string
  apiKey?: string
  onProgress?: ProgressCallback
  onConsoleLog?: ConsoleLogCallback
  allowedTools?: string
  disallowedTools?: string
}

export interface AgentExecutionResult {
  output: string
  exitCode: number
  durationMs: number
  sessionId: string | null
  timedOut: boolean
}

const DEFAULT_HTTP_TIMEOUT_MS = 60_000

export async function executeAgent(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const model = options.model.trim()
  if (model.startsWith('ollama:')) {
    return executeOllama(options)
  }
  if (model === 'codex' || model.startsWith('codex:')) {
    return executeCodex(options)
  }
  if (model === 'openai' || model.startsWith('openai:')) {
    return executeOpenAiApi(options)
  }
  if (model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')) {
    return executeAnthropicApi(options)
  }
  // Default: Claude Code CLI
  return executeClaude(options)
}

async function executeClaude(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const execOpts: ExecutionOptions = {
    timeoutMs: options.timeoutMs,
    maxTurns: options.maxTurns,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    onProgress: options.onProgress,
    onConsoleLog: options.onConsoleLog,
    resumeSessionId: options.resumeSessionId,
    systemPrompt: options.systemPrompt,
    model: options.model === 'claude' ? undefined : options.model
  }

  const result: ExecutionResult = await executeClaudeCode(options.prompt, execOpts)

  return {
    output: result.stdout,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    sessionId: result.sessionId,
    timedOut: result.timedOut
  }
}

async function executeCodex(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let sessionId: string | null = options.resumeSessionId ?? null
    let outputParts: string[] = []
    let buffer = ''

    const modelName = parseModelSuffix(options.model, 'codex')
    const prompt = buildPrompt(options.systemPrompt, options.prompt)
    const args = options.resumeSessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', options.resumeSessionId, prompt]
      : ['exec', '--json', '--skip-git-repo-check', prompt]
    if (modelName) {
      args.splice(2, 0, '--model', modelName)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('codex', args, {
        cwd: homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({
        output: `Error: Failed to spawn codex CLI: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: false
      })
      return
    }

    if (!proc.stdout || !proc.stderr) {
      resolve({
        output: 'Error: Failed to create stdio pipes for codex CLI',
        exitCode: 1,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: false
      })
      try { proc.kill() } catch {}
      return
    }

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stdout += chunk
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        parseCodexEventLine(line, (nextSessionId, textChunk) => {
          if (nextSessionId) sessionId = nextSessionId
          if (textChunk) outputParts.push(textChunk)
        })
      }
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, timeoutMs)

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (buffer.trim()) {
        parseCodexEventLine(buffer.trim(), (nextSessionId, textChunk) => {
          if (nextSessionId) sessionId = nextSessionId
          if (textChunk) outputParts.push(textChunk)
        })
      }
      const output = outputParts.join('\n\n').trim() || stderr.trim() || stdout.trim() || ''
      resolve({
        output,
        exitCode: code ?? (timedOut ? 124 : 1),
        durationMs: Date.now() - startTime,
        sessionId,
        timedOut
      })
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        output: `Error: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        sessionId,
        timedOut: false
      })
    })
  })
}

async function executeOpenAiApi(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const apiKey = options.apiKey?.trim() || (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) {
    return immediateError('Missing OpenAI API key. Set room credential "openai_api_key" or OPENAI_API_KEY.')
  }

  const modelName = parseModelSuffix(options.model, 'openai') || 'gpt-4o-mini'
  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })
  messages.push({ role: 'user', content: options.prompt })

  const startTime = Date.now()
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages
      }),
      signal: controller.signal
    })
    const json = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return {
        output: `OpenAI API ${response.status}: ${extractApiError(json)}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: false
      }
    }
    const output = extractOpenAiText(json)
    return {
      output,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = message.toLowerCase().includes('aborted') || message.toLowerCase().includes('timeout')
    return {
      output: `Error: ${message}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut
    }
  } finally {
    clearTimeout(timer)
  }
}

async function executeAnthropicApi(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const apiKey = options.apiKey?.trim() || (process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) {
    return immediateError('Missing Anthropic API key. Set room credential "anthropic_api_key" or ANTHROPIC_API_KEY.')
  }

  const modelName = parseAnthropicModel(options.model)
  const startTime = Date.now()
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 2048,
        system: options.systemPrompt,
        messages: [{ role: 'user', content: options.prompt }]
      }),
      signal: controller.signal
    })
    const json = await response.json() as Record<string, unknown>
    if (!response.ok) {
      return {
        output: `Anthropic API ${response.status}: ${extractApiError(json)}`,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: false
      }
    }
    const output = extractAnthropicText(json)
    return {
      output,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = message.toLowerCase().includes('aborted') || message.toLowerCase().includes('timeout')
    return {
      output: `Error: ${message}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut
    }
  } finally {
    clearTimeout(timer)
  }
}

async function executeOllama(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const modelName = options.model.replace(/^ollama:/, '')
  const startTime = Date.now()

  const messages: Array<{ role: string; content: string }> = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  messages.push({ role: 'user', content: options.prompt })

  const body = JSON.stringify({
    model: modelName,
    messages,
    stream: false
  })

  try {
    const response = await ollamaRequest('/api/chat', body, options.timeoutMs)
    const parsed = JSON.parse(response)
    const output = parsed?.message?.content ?? ''
    return {
      output,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  } catch (err) {
    const error = err as Error
    const isTimeout = error.message.includes('timeout') || error.message.includes('aborted')
    return {
      output: `Error: ${error.message}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: isTimeout
    }
  }
}

function parseModelSuffix(model: string, prefix: string): string {
  const trimmed = model.trim()
  if (trimmed === prefix) return ''
  const marker = `${prefix}:`
  if (!trimmed.startsWith(marker)) return ''
  return trimmed.slice(marker.length).trim()
}

function parseAnthropicModel(model: string): string {
  const normalized = model.trim()
  if (normalized === 'anthropic') return 'claude-3-5-sonnet-latest'
  const anthropicModel = parseModelSuffix(normalized, 'anthropic')
  if (anthropicModel) return anthropicModel
  const claudeApiModel = parseModelSuffix(normalized, 'claude-api')
  if (claudeApiModel) return claudeApiModel
  return normalized
}

function parseCodexEventLine(
  line: string,
  onEvent: (sessionId: string | null, textChunk: string | null) => void
): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return
  }
  const type = parsed.type
  if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
    onEvent(parsed.thread_id, null)
    return
  }
  if (type === 'item.completed') {
    const item = parsed.item as Record<string, unknown> | undefined
    if (!item) return
    const itemType = item.type
    if (itemType === 'agent_message' && typeof item.text === 'string') {
      onEvent(null, item.text)
    }
  }
}

function extractOpenAiText(json: Record<string, unknown>): string {
  const choices = json.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>
    const message = first.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          const block = item as Record<string, unknown>
          const blockText = block.text
          return typeof blockText === 'string' ? blockText : ''
        })
        .filter(Boolean)
        .join('\n')
        .trim()
      if (text) return text
    }
  }
  return JSON.stringify(json)
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = json.content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const block = item as Record<string, unknown>
        return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }
  return JSON.stringify(json)
}

function extractApiError(json: Record<string, unknown>): string {
  const error = json.error as Record<string, unknown> | undefined
  if (!error) return JSON.stringify(json)
  if (typeof error.message === 'string') return error.message
  return JSON.stringify(error)
}

function buildPrompt(systemPrompt: string | undefined, prompt: string): string {
  if (!systemPrompt) return prompt
  return `System instructions:\n${systemPrompt}\n\nUser request:\n${prompt}`
}

function immediateError(message: string): AgentExecutionResult {
  return {
    output: `Error: ${message}`,
    exitCode: 1,
    durationMs: 0,
    sessionId: null,
    timedOut: false
  }
}

/**
 * Execute Ollama inference on a cloud station.
 * Sends the prompt to the station's local Ollama API via exec.
 */
export async function executeOllamaOnStation(
  cloudRoomId: string,
  stationId: number,
  options: AgentExecutionOptions
): Promise<AgentExecutionResult> {
  const modelName = options.model.replace(/^ollama:/, '')
  const startTime = Date.now()

  const messages: Array<{ role: string; content: string }> = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  messages.push({ role: 'user', content: options.prompt })

  const payload = JSON.stringify({
    model: modelName,
    messages,
    stream: false
  })

  // Base64-encode to avoid shell escaping issues with long prompts
  const b64 = Buffer.from(payload).toString('base64')
  const command = `echo '${b64}' | base64 -d | curl -s --max-time 300 http://localhost:11434/api/chat -d @-`

  // 360s timeout (300s curl + 60s buffer for network/overhead)
  const result = await execOnCloudStation(cloudRoomId, stationId, command, 360000)

  if (!result) {
    return {
      output: 'Error: station execution failed (station unreachable or Ollama not running)',
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }

  if (result.exitCode !== 0) {
    return {
      output: result.stderr || result.stdout || `Station exec failed with exit code ${result.exitCode}`,
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }

  try {
    const parsed = JSON.parse(result.stdout)
    return {
      output: parsed?.message?.content ?? '',
      exitCode: 0,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  } catch {
    // Response wasn't valid JSON — return raw output
    return {
      output: result.stdout || '(no output from Ollama)',
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    await ollamaRequest('/api/tags', undefined, 5000)
    return true
  } catch {
    return false
  }
}

export async function listOllamaModels(): Promise<Array<{ name: string; size: number }>> {
  try {
    const response = await ollamaRequest('/api/tags', undefined, 5000)
    const parsed = JSON.parse(response) as { models?: Array<{ name: string; size: number }> }
    return (parsed.models ?? []).map(m => ({ name: m.name, size: m.size }))
  } catch {
    return []
  }
}

function ollamaRequest(path: string, body?: string, timeoutMs: number = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: 11434,
      path,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : undefined,
      timeout: timeoutMs
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data)
        } else {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`))
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Ollama request timeout'))
    })

    if (body) req.write(body)
    req.end()
  })
}
