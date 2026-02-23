import http from 'node:http'
import { execSync, spawn } from 'node:child_process'

const OLLAMA_INSTALL_TIMEOUT_MS = 120_000
const OLLAMA_STARTUP_TIMEOUT_MS = 30_000

// ─── Low-level HTTP helper ──────────────────────────────────────────────────

export function ollamaRequest(path: string, body?: string, timeoutMs: number = 300_000): Promise<string> {
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

/**
 * Streaming ollama request — reads NDJSON line by line and accumulates the full response.
 * Destroying the request mid-stream cancels ollama inference (unlike non-streaming mode).
 * Returns the accumulated content when done=true or on timeout.
 */
export function ollamaStreamRequest(path: string, body: string, timeoutMs: number = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body)
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: 11434,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.byteLength }
    }

    let settled = false
    let content = ''
    let lineBuffer = ''

    const finish = (result: string | Error): void => {
      if (settled) return
      settled = true
      req.destroy()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }

    const timer = setTimeout(() => finish(new Error('Ollama request timeout')), timeoutMs)

    const req = http.request(options, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer)
        finish(new Error(`Ollama HTTP ${res.statusCode}`))
        return
      }

      res.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString()
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const evt = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean; error?: string }
            if (evt.error) { clearTimeout(timer); finish(new Error(evt.error)); return }
            if (evt.message?.content) content += evt.message.content
            if (evt.done) { clearTimeout(timer); finish(content); return }
          } catch { /* ignore malformed lines */ }
        }
      })

      res.on('end', () => { clearTimeout(timer); finish(content) })
      res.on('error', (err) => { clearTimeout(timer); finish(err) })
    })

    req.on('error', (err) => { clearTimeout(timer); finish(err) })
    req.write(bodyBuf)
    req.end()
  })
}

// ─── Availability checks ────────────────────────────────────────────────────

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

// ─── Binary management ──────────────────────────────────────────────────────

export function hasOllamaBinary(): boolean {
  try {
    execSync('which ollama 2>/dev/null', { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export function installOllamaBinary(): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync('brew install ollama 2>&1', { timeout: OLLAMA_INSTALL_TIMEOUT_MS })
    } else {
      execSync('curl -fsSL https://ollama.com/install.sh | sh 2>&1', { timeout: OLLAMA_INSTALL_TIMEOUT_MS })
    }
    return true
  } catch {
    return false
  }
}

export function startOllamaServe(): boolean {
  try {
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

export async function waitForOllamaAvailable(timeoutMs: number = OLLAMA_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOllamaAvailable()) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

export async function ensureOllamaRunning(): Promise<{ available: boolean; status: 'running' | 'install_failed' | 'start_failed' }> {
  const already = await isOllamaAvailable()
  if (already) return { available: true, status: 'running' }

  if (!hasOllamaBinary() && !installOllamaBinary()) {
    return { available: false, status: 'install_failed' }
  }
  if (!startOllamaServe()) {
    return { available: false, status: 'start_failed' }
  }

  const available = await waitForOllamaAvailable()
  return { available, status: available ? 'running' : 'start_failed' }
}

// ─── Model management ───────────────────────────────────────────────────────

export function isModelInstalled(models: Array<{ name: string; size: number }>, requested: string): boolean {
  const requestedLower = requested.toLowerCase()
  for (const model of models) {
    const installedName = model.name.toLowerCase()
    if (installedName === requestedLower) return true
    if (!requestedLower.includes(':') && installedName === `${requestedLower}:latest`) return true
    if (requestedLower.endsWith(':latest') && installedName === requestedLower.slice(0, -7)) return true
  }
  return false
}

export async function pullOllamaModel(model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let proc: ReturnType<typeof spawn>

    try {
      proc = spawn('ollama', ['pull', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, error: `Failed to start ollama pull: ${message}` })
      return
    }

    const finish = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish({ ok: false, error: `Timed out while pulling model ${model}` })
    }, 15 * 60 * 1000)

    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      const message = err instanceof Error ? err.message : String(err)
      finish({ ok: false, error: `ollama pull failed: ${message}` })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const details = `${stderr}\n${stdout}`.trim().split('\n').slice(-3).join('\n')
      finish({ ok: false, error: details || `ollama pull exited with code ${code ?? -1}` })
    })
  })
}

/**
 * Ensure Ollama is running and the specified model is available.
 * Auto-installs Ollama, starts the server, and pulls the model if needed.
 */
export async function ensureOllamaModel(modelName: string): Promise<void> {
  const running = await ensureOllamaRunning()
  if (!running.available) {
    throw new Error(`Ollama unavailable (${running.status})`)
  }

  const installed = await listOllamaModels()
  if (isModelInstalled(installed, modelName)) return

  const pulled = await pullOllamaModel(modelName)
  if (!pulled.ok) {
    throw new Error(`Failed to pull model ${modelName}: ${pulled.ok === false ? pulled.error : 'unknown'}`)
  }
}
