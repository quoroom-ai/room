import { execFileSync } from 'node:child_process'

type ProviderName = 'codex' | 'claude'

const CLI_PROBE_TIMEOUT_MS = 1500

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Returns the CLI command name, adding `.cmd` suffix on Windows. */
export function getProviderCliCommand(
  provider: ProviderName,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? `${provider}.cmd` : provider
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
  const cmd = getProviderCliCommand(provider)
  const out = safeExec(cmd, ['--version'])
  return out.ok ? { installed: true, version: out.stdout || undefined } : { installed: false }
}

export function probeProviderConnected(provider: ProviderName): boolean | null {
  // Claude Code has no `auth status` subcommand — all interactive commands
  // require a TTY and hang in headless contexts. Subscription users are
  // automatically authenticated when installed, so treat installed = connected.
  if (provider === 'claude') {
    return probeProviderInstalled('claude').installed ? true : null
  }

  const cmd = getProviderCliCommand(provider)
  const attempts = provider === 'codex'
    ? [['login', 'status'], ['auth', 'status']]
    : [['auth', 'status'], ['login', 'status']]
  for (const args of attempts) {
    const out = safeExec(cmd, args)
    if (!out.ok) continue
    const combined = `${out.stdout}\n${out.stderr}`.toLowerCase()
    if (combined.includes('not logged') || combined.includes('logged out') || combined.includes('unauth')) return false
    return true
  }
  return null
}

export function disconnectProvider(provider: ProviderName): { command: string; result: CommandResult } {
  const cmd = getProviderCliCommand(provider)
  const args = ['logout']
  return {
    command: `${provider} ${args.join(' ')}`,
    result: safeExec(cmd, args),
  }
}
