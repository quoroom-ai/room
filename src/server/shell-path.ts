/**
 * Inherit login shell PATH for packaged apps.
 *
 * macOS: Packaged apps (.pkg) don't inherit the user's login shell PATH,
 * so tools like `claude`, `codex`, `npm` installed via Homebrew, NVM,
 * or user-space managers are invisible. This runs the login shell once
 * at startup to capture the full PATH and merges it into process.env.PATH.
 *
 * Windows: The system tray launcher may not inherit the full user PATH.
 * We add the npm global prefix directory so globally-installed CLIs
 * (claude, codex) are discoverable.
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function inheritShellPath(): void {
  if (process.platform === 'win32') {
    inheritWindowsPath()
    return
  }
  if (process.platform === 'darwin') {
    inheritDarwinPath()
    return
  }
  // Linux: also try npm global bin enrichment
  inheritWindowsPath()
}

/** macOS: run login shell to capture full PATH */
function inheritDarwinPath(): void {
  const currentPath = process.env.PATH || ''
  const currentParts = new Set(currentPath.split(path.delimiter).filter(Boolean))

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter(Boolean) as string[]

  for (const sh of shells) {
    if (!existsSync(sh)) continue
    try {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE

      const shellPath = execSync(`${sh} -lic 'echo $PATH'`, {
        encoding: 'utf-8',
        env,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()

      if (!shellPath) continue

      const newParts = shellPath.split(path.delimiter).filter(Boolean)
      const additions: string[] = []
      for (const p of newParts) {
        if (!currentParts.has(p)) {
          additions.push(p)
          currentParts.add(p)
        }
      }

      if (additions.length > 0) {
        process.env.PATH = `${currentPath}${path.delimiter}${additions.join(path.delimiter)}`
      }
      return
    } catch {
      // Shell failed, try next
    }
  }
}

/** Windows/Linux: ensure npm global prefix dir is in PATH */
function inheritWindowsPath(): void {
  const isWindows = process.platform === 'win32'
  const npmCommand = isWindows ? 'npm.cmd' : 'npm'
  try {
    // `npm bin -g` was removed in npm 9+; use `npm prefix -g` instead
    const npmPrefix = execFileSync(npmCommand, ['prefix', '-g'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: isWindows,
    }).toString().trim()
    if (!npmPrefix) return

    // On Unix the binaries live in <prefix>/bin; on Windows they're directly in <prefix>
    const npmBin = isWindows ? npmPrefix : path.join(npmPrefix, 'bin')

    const currentPath = process.env.PATH || ''
    const parts = currentPath.split(path.delimiter).filter(Boolean)
    if (parts.includes(npmBin)) return
    process.env.PATH = `${npmBin}${path.delimiter}${currentPath}`
  } catch {
    // npm not available; nothing to enrich
  }
}
