/**
 * Inherit login shell PATH for packaged macOS apps.
 *
 * Packaged apps (.pkg) don't inherit the user's login shell PATH,
 * so tools like `claude`, `codex`, `npm` installed via Homebrew, NVM,
 * or user-space managers are invisible. This runs the login shell once
 * at startup to capture the full PATH and merges it into process.env.PATH.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function inheritShellPath(): void {
  if (process.platform !== 'darwin') return

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
