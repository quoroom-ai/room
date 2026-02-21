import http from 'http'
import { executeClaudeCode } from './claude-code'
import type { ExecutionOptions, ExecutionResult, ConsoleLogCallback, ProgressCallback } from './claude-code'
import { execOnCloudStation } from './cloud-sync'

export interface AgentExecutionOptions {
  model: string // 'claude' | 'ollama:llama3' | 'ollama:mistral' | etc.
  prompt: string
  systemPrompt?: string
  maxTurns?: number
  timeoutMs?: number
  resumeSessionId?: string
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

export async function executeAgent(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  if (options.model.startsWith('ollama:')) {
    return executeOllama(options)
  }
  // Default: Claude CLI
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
