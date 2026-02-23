import { spawn } from 'child_process'
import { homedir } from 'os'
import { executeClaudeCode } from './claude-code'
import type { ExecutionOptions, ExecutionResult, ConsoleLogCallback, ProgressCallback } from './claude-code'
import { execOnCloudStation } from './cloud-sync'
import { ensureOllamaModel, ollamaRequest, ollamaStreamRequest, isOllamaAvailable, listOllamaModels } from './ollama-ensure'
import type { OllamaToolDef } from './queen-tools'

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
  // Ollama tool-calling support
  toolDefs?: OllamaToolDef[]
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>
  /**
   * Use plain JSON output mode instead of native tool-calling API.
   * Faster for small models (llama3.2) — avoids constrained decoding overhead.
   */
  useJsonActionMode?: boolean
  /**
   * Prior conversation messages to prepend (session continuity across cycles).
   * When set, the current prompt is appended as a "NEW CYCLE" continuation message
   * rather than starting a fresh conversation.
   */
  previousMessages?: Array<{ role: string; content: string }>
  /**
   * Called after each turn with the updated messages array so the caller can
   * persist the session for the next cycle.
   */
  onSessionUpdate?: (messages: Array<{ role: string; content: string }>) => void
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
    if (options.toolDefs && options.toolDefs.length > 0 && options.onToolCall) {
      if (options.useJsonActionMode) {
        return executeOllamaJsonActions(options)
      }
      return executeOllamaWithTools(options)
    }
    return executeOllama(options)
  }
  if (model === 'codex' || model.startsWith('codex:')) {
    return executeCodex(options)
  }
  if (model === 'openai' || model.startsWith('openai:')) {
    if (options.toolDefs && options.toolDefs.length > 0 && options.onToolCall) {
      return executeOpenAiWithTools(options)
    }
    return executeOpenAiApi(options)
  }
  if (model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')) {
    if (options.toolDefs && options.toolDefs.length > 0 && options.onToolCall) {
      return executeAnthropicWithTools(options)
    }
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

// ─── Ollama JSON action mode (fast — no constrained tool decoding) ──────────
// Instead of using the `tools` API (slow constrained JSON decoding for small models),
// we ask the model to output a JSON action object via plain chat + format:"json".
// The prompt already lists the available actions; we parse the response and dispatch.

async function executeOllamaJsonActions(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const modelName = options.model.replace(/^ollama:/, '')
  const startTime = Date.now()

  try {
    await ensureOllamaModel(modelName)
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }

  // Build a concise action schema from the slim tool defs
  const toolSchemas = (options.toolDefs ?? []).map(t => {
    const props = t.function.parameters.properties
    const required = t.function.parameters.required ?? []
    const fields = Object.entries(props)
      .filter(([k]) => required.includes(k))
      .map(([k, v]) => `"${k}": <${v.type}>`)
      .join(', ')
    return `  "${t.function.name}": {${fields}}`
  }).join('\n')

  const actionSystemPrompt = [
    options.systemPrompt ?? '',
    `\nRespond with ONLY a valid JSON object — no explanation, no markdown, no text before or after.\nFormat: {"tool": "<tool_name>", "args": {<args>}}\n\nAvailable tools:\n${toolSchemas}`
  ].join('\n').trim()

  const timeoutMs = options.timeoutMs ?? 90_000
  const maxTurns = options.maxTurns ?? 5
  let finalOutput = ''

  // Session continuity: resume from previous messages, append current cycle as new turn
  const isResume = (options.previousMessages?.length ?? 0) > 0
  const currentUserMsg = isResume
    ? `NEW CYCLE. Updated room state:\n${options.prompt}\n\nContinue working toward the goal. Respond with your next JSON action.`
    : options.prompt
  const messages: Array<{ role: string; content: string }> = [
    ...(options.previousMessages ?? []),
    { role: 'user', content: currentUserMsg }
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = JSON.stringify({
      model: modelName,
      system: actionSystemPrompt,
      messages,
      format: 'json',
      stream: true, // streaming so timeout actually cancels inference in ollama
      options: { temperature: 0.7 }
    })

    let responseText = ''
    try {
      // Streaming: cancelling the request mid-stream stops ollama inference
      // (unlike stream:false where ollama keeps running even after client disconnects)
      responseText = await ollamaStreamRequest('/api/chat', body, timeoutMs)
    } catch (err) {
      const error = err as Error
      const isTimeout = error.message.includes('timeout') || error.message.includes('aborted')
      return {
        output: `Error: ${error.message}`,
        exitCode: isTimeout ? 124 : 1,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: isTimeout
      }
    }

    // Parse the action from the response
    let toolName = ''
    let args: Record<string, unknown> = {}
    try {
      // Find JSON object in the response (handles extra whitespace/text)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>

        // Format 1 (expected): {"tool": "name", "args": {...}}
        if (typeof parsed.tool === 'string') {
          toolName = parsed.tool.trim()
          args = (parsed.args as Record<string, unknown>) ?? {}
        }
        // Format 2 (model fallback): {"<toolName>": {<args>}}
        // Model uses the tool name directly as the key
        else {
          const knownTools = new Set(options.toolDefs?.map(t => t.function.name) ?? [])
          const foundKey = Object.keys(parsed).find(k => knownTools.has(k))
          if (foundKey) {
            toolName = foundKey
            const rawArgs = parsed[foundKey]
            args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
          }
        }
      }
    } catch {
      // Couldn't parse — model responded with non-JSON text
      finalOutput = responseText
      break
    }

    if (!toolName || !options.onToolCall) {
      // Non-JSON or "done" response — end cycle, save session
      messages.push({ role: 'assistant', content: responseText })
      finalOutput = responseText
      options.onSessionUpdate?.(messages)
      break
    }

    // Execute the action
    let toolResult: string
    try {
      toolResult = await options.onToolCall(toolName, args)
    } catch (err) {
      toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    finalOutput = `${toolName}: ${toolResult}`

    // Feed result back so model can chain actions within the same cycle
    messages.push({ role: 'assistant', content: responseText })
    messages.push({ role: 'user', content: `Result: ${toolResult}\nNext action? (JSON tool call, or {"done": true} to end cycle)` })
    options.onSessionUpdate?.(messages)
    // continue to next turn
  }

  return {
    output: finalOutput || 'No action taken.',
    exitCode: 0,
    durationMs: Date.now() - startTime,
    sessionId: null,
    timedOut: false
  }
}

// ─── Ollama multi-turn tool-call loop ──────────────────────────────────────

interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown> | string
  }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
}

async function executeOllamaWithTools(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const modelName = options.model.replace(/^ollama:/, '')
  const startTime = Date.now()

  try {
    await ensureOllamaModel(modelName)
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }

  const messages: OllamaMessage[] = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  messages.push({ role: 'user', content: options.prompt })

  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const maxTurns = options.maxTurns ?? 10
  let finalOutput = ''

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = JSON.stringify({
      model: modelName,
      messages,
      tools: options.toolDefs,
      stream: false
    })

    let raw: string
    try {
      raw = await ollamaRequest('/api/chat', body, timeoutMs)
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

    let parsed: { message: OllamaMessage }
    try {
      parsed = JSON.parse(raw) as { message: OllamaMessage }
    } catch {
      return {
        output: raw,
        exitCode: 0,
        durationMs: Date.now() - startTime,
        sessionId: null,
        timedOut: false
      }
    }

    const msg = parsed.message
    const toolCalls = msg.tool_calls ?? []

    if (toolCalls.length === 0) {
      // No tool calls — this is the final text response
      finalOutput = msg.content ?? ''
      break
    }

    // Has tool calls: add assistant message, then execute each tool
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls })

    for (const tc of toolCalls) {
      const name = tc.function.name
      const rawArgs = tc.function.arguments
      const args: Record<string, unknown> =
        typeof rawArgs === 'string'
          ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown> } catch { return {} } })()
          : rawArgs

      let toolResult = `Tool ${name} unavailable`
      if (options.onToolCall) {
        try {
          toolResult = await options.onToolCall(name, args)
        } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      messages.push({ role: 'tool', content: toolResult })
    }
  }

  return {
    output: finalOutput || 'Actions completed.',
    exitCode: 0,
    durationMs: Date.now() - startTime,
    sessionId: null,
    timedOut: false
  }
}

// ─── OpenAI multi-turn tool-call loop ──────────────────────────────────────

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

async function executeOpenAiWithTools(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const apiKey = options.apiKey?.trim() || (process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) return immediateError('Missing OpenAI API key.')

  const modelName = parseModelSuffix(options.model, 'openai') || 'gpt-4o-mini'
  const startTime = Date.now()
  const maxTurns = options.maxTurns ?? 10

  // Session continuity: resume from prior conversation turns (no system prompt stored)
  const previousTurns = (options.previousMessages ?? []) as OpenAiMessage[]
  const isResume = previousTurns.length > 0
  const messages: OpenAiMessage[] = [
    ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
    ...previousTurns,
    {
      role: 'user' as const,
      content: isResume
        ? `NEW CYCLE. Updated room state:\n${options.prompt}\n\nContinue working toward the goal.`
        : options.prompt
    }
  ]

  let finalOutput = ''

  for (let turn = 0; turn < maxTurns; turn++) {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let json: Record<string, unknown>
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages, tools: options.toolDefs }),
        signal: controller.signal
      })
      json = await response.json() as Record<string, unknown>
      if (!response.ok) {
        return { output: `OpenAI API ${response.status}: ${extractApiError(json)}`, exitCode: 1, durationMs: Date.now() - startTime, sessionId: null, timedOut: false }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const timedOut = msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('timeout')
      return { output: `Error: ${msg}`, exitCode: 1, durationMs: Date.now() - startTime, sessionId: null, timedOut }
    } finally {
      clearTimeout(timer)
    }

    const choices = json.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0] as Record<string, unknown> | undefined
    const msg = choice?.message as OpenAiMessage | undefined
    if (!msg) break

    const toolCalls = msg.tool_calls ?? []
    if (toolCalls.length === 0) {
      finalOutput = (typeof msg.content === 'string' ? msg.content : '') ?? ''
      break
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      const name = tc.function.name
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments) as Record<string, unknown> } catch { /* ignore */ }

      let toolResult = `Tool ${name} unavailable`
      if (options.onToolCall) {
        try { toolResult = await options.onToolCall(name, args) } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult })
    }

    // Persist session after each tool exchange (strip system prompt before saving)
    if (options.onSessionUpdate) {
      options.onSessionUpdate(messages.filter(m => m.role !== 'system') as Array<{ role: string; content: string }>)
    }
  }

  return { output: finalOutput || 'Actions completed.', exitCode: 0, durationMs: Date.now() - startTime, sessionId: null, timedOut: false }
}

// ─── Anthropic multi-turn tool-call loop ────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

function ollamaToolDefsToAnthropic(defs: import('./queen-tools').OllamaToolDef[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return defs.map(d => ({
    name: d.function.name,
    description: d.function.description,
    input_schema: d.function.parameters as Record<string, unknown>
  }))
}

async function executeAnthropicWithTools(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const apiKey = options.apiKey?.trim() || (process.env.ANTHROPIC_API_KEY || '').trim()
  if (!apiKey) return immediateError('Missing Anthropic API key.')

  const modelName = parseAnthropicModel(options.model)
  const startTime = Date.now()
  const maxTurns = options.maxTurns ?? 10
  const anthropicTools = options.toolDefs ? ollamaToolDefsToAnthropic(options.toolDefs) : []

  // Session continuity: resume from prior conversation turns (system prompt passed separately)
  const previousTurns = (options.previousMessages ?? []) as AnthropicMessage[]
  const isResume = previousTurns.length > 0
  const messages: AnthropicMessage[] = [
    ...previousTurns,
    {
      role: 'user',
      content: isResume
        ? `NEW CYCLE. Updated room state:\n${options.prompt}\n\nContinue working toward the goal.`
        : options.prompt
    }
  ]
  let finalOutput = ''

  for (let turn = 0; turn < maxTurns; turn++) {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let json: Record<string, unknown>
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
          max_tokens: 4096,
          system: options.systemPrompt,
          tools: anthropicTools,
          messages
        }),
        signal: controller.signal
      })
      json = await response.json() as Record<string, unknown>
      if (!response.ok) {
        return { output: `Anthropic API ${response.status}: ${extractApiError(json)}`, exitCode: 1, durationMs: Date.now() - startTime, sessionId: null, timedOut: false }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const timedOut = msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('timeout')
      return { output: `Error: ${msg}`, exitCode: 1, durationMs: Date.now() - startTime, sessionId: null, timedOut }
    } finally {
      clearTimeout(timer)
    }

    const stopReason = json.stop_reason as string | undefined
    const content = json.content as AnthropicContentBlock[] | undefined

    const toolUseBlocks = (content ?? []).filter(b => b.type === 'tool_use')
    const textBlocks = (content ?? []).filter(b => b.type === 'text')

    if (toolUseBlocks.length === 0 || stopReason !== 'tool_use') {
      finalOutput = textBlocks.map(b => b.text ?? '').join('\n').trim()
      break
    }

    // Add assistant message with tool_use blocks
    messages.push({ role: 'assistant', content: content ?? [] })

    // Execute tools and build tool_result message
    const resultBlocks: AnthropicContentBlock[] = []
    for (const block of toolUseBlocks) {
      const name = block.name ?? ''
      const args = (block.input ?? {}) as Record<string, unknown>
      let toolResult = `Tool ${name} unavailable`
      if (options.onToolCall) {
        try { toolResult = await options.onToolCall(name, args) } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      resultBlocks.push({ type: 'tool_result', id: block.id, content: toolResult } as unknown as AnthropicContentBlock)
    }
    messages.push({ role: 'user', content: resultBlocks })

    // Persist session after each tool exchange
    if (options.onSessionUpdate) {
      options.onSessionUpdate(messages as unknown as Array<{ role: string; content: string }>)
    }
  }

  return { output: finalOutput || 'Actions completed.', exitCode: 0, durationMs: Date.now() - startTime, sessionId: null, timedOut: false }
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

  // Auto-start Ollama and pull model if needed
  try {
    await ensureOllamaModel(modelName)
  } catch (err) {
    return {
      output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }

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
    const response = await ollamaRequest('/api/chat', body, options.timeoutMs ?? 5 * 60 * 1000)
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
 * Compress a long conversation history into a compact JSON summary.
 * Called at the start of a cycle when the session exceeds the trim threshold.
 * Applies to API/ollama models (Group B/C). CLI models manage their own context.
 *
 * Returns the raw summary text (JSON string from the model), or null on failure.
 */
export async function compressSession(
  model: string,
  apiKey: string | undefined,
  history: Array<{ role: string; content: string }>
): Promise<string | null> {
  const historyText = history
    .map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return `[${m.role}]: ${content.slice(0, 2000)}`
    })
    .join('\n---\n')

  const compressionPrompt = `You are summarizing your own previous session history as the queen of an AI collective room.
Compress the history below into a concise memory that preserves all important decisions and context.
History:
${historyText}

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "session_summary": "...",
  "goals_set": ["..."],
  "workers_created": [{"name": "...", "role": "..."}],
  "decisions_approved": ["..."],
  "decisions_rejected": ["..."],
  "last_actions": ["..."],
  "next_intention": "..."
}`

  const timeoutMs = 60_000
  try {
    if (model.startsWith('ollama:')) {
      const modelName = model.replace(/^ollama:/, '')
      const body = JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: compressionPrompt }],
        stream: false
      })
      const response = await ollamaRequest('/api/chat', body, timeoutMs)
      const parsed = JSON.parse(response) as Record<string, unknown>
      const text = (parsed?.message as Record<string, unknown>)?.content as string | undefined
      return text?.trim() ?? null
    }

    if (model === 'openai' || model.startsWith('openai:')) {
      const key = apiKey?.trim() || (process.env.OPENAI_API_KEY || '').trim()
      if (!key) return null
      const modelName = parseModelSuffix(model, 'openai') || 'gpt-4o-mini'
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: compressionPrompt }] }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const json = await response.json() as Record<string, unknown>
      return extractOpenAiText(json).trim() || null
    }

    if (model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')) {
      const key = apiKey?.trim() || (process.env.ANTHROPIC_API_KEY || '').trim()
      if (!key) return null
      const modelName = parseAnthropicModel(model)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, max_tokens: 1024, messages: [{ role: 'user', content: compressionPrompt }] }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const json = await response.json() as Record<string, unknown>
      return extractAnthropicText(json).trim() || null
    }
  } catch {
    // Non-fatal: fall through to hard trim
  }
  return null
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

/**
 * Execute an API-key model (openai:* or anthropic:*) on a cloud station via curl.
 */
export async function executeApiOnStation(
  cloudRoomId: string,
  stationId: number,
  options: AgentExecutionOptions
): Promise<AgentExecutionResult> {
  const startTime = Date.now()
  const apiKey = options.apiKey
  if (!apiKey) {
    return immediateError('Missing API key for station execution.')
  }

  const isOpenAi = options.model.startsWith('openai:')
  const messages: Array<{ role: string; content: string }> = []
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })
  messages.push({ role: 'user', content: options.prompt })

  let url: string
  let headers: Record<string, string>
  let body: string

  if (isOpenAi) {
    const modelName = parseModelSuffix(options.model, 'openai') || 'gpt-4o-mini'
    url = 'https://api.openai.com/v1/chat/completions'
    headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    body = JSON.stringify({ model: modelName, messages })
  } else {
    const modelName = parseAnthropicModel(options.model)
    url = 'https://api.anthropic.com/v1/messages'
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    body = JSON.stringify({
      model: modelName,
      max_tokens: 2048,
      system: options.systemPrompt,
      messages: [{ role: 'user', content: options.prompt }]
    })
  }

  // Build curl command with headers
  const headerFlags = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ')
  const b64 = Buffer.from(body).toString('base64')
  const command = `echo '${b64}' | base64 -d | curl -s --max-time 300 ${headerFlags} -d @- '${url}'`

  const result = await execOnCloudStation(cloudRoomId, stationId, command, 360000)

  if (!result) {
    return {
      output: 'Error: station execution failed (station unreachable)',
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
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    const output = isOpenAi ? extractOpenAiText(parsed) : extractAnthropicText(parsed)
    return { output, exitCode: 0, durationMs: Date.now() - startTime, sessionId: null, timedOut: false }
  } catch {
    return {
      output: result.stdout || '(no output from API)',
      exitCode: 1,
      durationMs: Date.now() - startTime,
      sessionId: null,
      timedOut: false
    }
  }
}

// isOllamaAvailable, listOllamaModels, ollamaRequest — re-exported from ollama-ensure.ts
export { isOllamaAvailable, listOllamaModels }
