import { execFileSync } from 'node:child_process'
import type { ProviderName } from './provider-auth'

const CLI_PROBE_TIMEOUT_MS = 1500

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export function safeExec(cmd: string, args: string[]): CommandResult {
  try {
    const stdout = execFileSync(cmd, args, { timeout: CLI_PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
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

export function probeProviderInstalled(provider: ProviderName): { installed: boolean; version?: string } {
  const out = safeExec(provider, ['--version'])
  return out.ok ? { installed: true, version: out.stdout || undefined } : { installed: false }
}

export function probeProviderConnected(provider: ProviderName): boolean | null {
  const attempts = provider === 'codex'
    ? [['login', 'status'], ['auth', 'status']]
    : [['auth', 'status'], ['login', 'status']]
  for (const args of attempts) {
    const out = safeExec(provider, args)
    if (!out.ok) continue
    const combined = `${out.stdout}\n${out.stderr}`.toLowerCase()
    if (combined.includes('not logged') || combined.includes('logged out') || combined.includes('unauth')) return false
    return true
  }
  return null
}

export function disconnectProvider(provider: ProviderName): { command: string; result: CommandResult } {
  const args = ['logout']
  return {
    command: `${provider} ${args.join(' ')}`,
    result: safeExec(provider, args),
  }
}
