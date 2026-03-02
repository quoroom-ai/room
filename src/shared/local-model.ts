import { execFileSync } from 'node:child_process'

export const OLLAMA_MODEL_TAG = 'qwen3-coder:30b'
export const OLLAMA_MODEL_ID = `ollama:${OLLAMA_MODEL_TAG}`
export const OLLAMA_HTTP_BASE_URL = 'http://127.0.0.1:11434/v1/chat/completions'

const OLLAMA_PROBE_TIMEOUT_MS = 5000

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface OllamaRuntimeStatus {
  installed: boolean
  version: string | null
  daemonReachable: boolean
  modelAvailable: boolean
  models: string[]
  ready: boolean
  error: string | null
}

/** Returns the CLI command name, adding .exe on Windows. */
export function getOllamaCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ollama.exe' : 'ollama'
}

export function safeExec(cmd: string, args: string[]): CommandResult {
  try {
    const opts: Record<string, unknown> = {
      timeout: OLLAMA_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    if (process.platform === 'win32') opts.shell = true
    const stdout = execFileSync(cmd, args, opts).toString().trim()
    return { ok: true, stdout, stderr: '' }
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    return {
      ok: false,
      stdout: e.stdout?.toString().trim() ?? '',
      stderr: e.stderr?.toString().trim() || e.message || '',
    }
  }
}

function parseModelName(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // ollama list rows are plain table rows, model name is first token.
  const token = trimmed.split(/\s+/)[0]?.trim()
  if (!token) return null
  if (token.toLowerCase() === 'name') return null
  return token
}

export function parseOllamaList(raw: string): string[] {
  const lines = raw.split(/\r?\n/)
  const models: string[] = []
  for (const line of lines) {
    const model = parseModelName(line)
    if (model) models.push(model)
  }
  return [...new Set(models)]
}

export function probeOllamaRuntime(modelTag: string = OLLAMA_MODEL_TAG): OllamaRuntimeStatus {
  const cmd = getOllamaCommand()
  const versionRes = safeExec(cmd, ['--version'])
  if (!versionRes.ok) {
    return {
      installed: false,
      version: null,
      daemonReachable: false,
      modelAvailable: false,
      models: [],
      ready: false,
      error: versionRes.stderr || 'ollama is not installed',
    }
  }

  const listRes = safeExec(cmd, ['list'])
  if (!listRes.ok) {
    return {
      installed: true,
      version: versionRes.stdout || null,
      daemonReachable: false,
      modelAvailable: false,
      models: [],
      ready: false,
      error: listRes.stderr || 'ollama daemon is unavailable',
    }
  }

  const models = parseOllamaList(listRes.stdout)
  const modelAvailable = models.some((name) => name.toLowerCase() === modelTag.toLowerCase())
  return {
    installed: true,
    version: versionRes.stdout || null,
    daemonReachable: true,
    modelAvailable,
    models,
    ready: modelAvailable,
    error: modelAvailable ? null : `model "${modelTag}" is not installed`,
  }
}

export function buildOllamaUnavailableMessage(status: OllamaRuntimeStatus, modelTag: string = OLLAMA_MODEL_TAG): string {
  if (!status.installed) {
    return `Local model unavailable: Ollama is not installed. Install Ollama and pull "${modelTag}".`
  }
  if (!status.daemonReachable) {
    return 'Local model unavailable: Ollama daemon is not running. Start Ollama and retry.'
  }
  if (!status.modelAvailable) {
    return `Local model unavailable: "${modelTag}" is missing. Run "ollama pull ${modelTag}" and retry.`
  }
  return ''
}
