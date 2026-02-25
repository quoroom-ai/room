#!/usr/bin/env node

/**
 * Cross-platform replacement for the shell-based test:smart-e2e script.
 * Checks if staged files touch UI/server/e2e paths and runs e2e smoke tests if so.
 */

const { execSync, spawnSync } = require('child_process')

const IS_WIN = process.platform === 'win32'

// Get staged file names
let files
try {
  files = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim()
} catch {
  console.log('No git changes — skipping E2E')
  process.exit(0)
}

if (!files) {
  console.log('No staged changes — skipping E2E')
  process.exit(0)
}

const pattern = /^(src\/ui\/|src\/server\/|e2e\/|playwright)/
const hasRelevant = files.split(/\r?\n/).some((f) => pattern.test(f))

if (!hasRelevant) {
  console.log('No UI/server changes — skipping E2E')
  process.exit(0)
}

console.log('Staged files touch UI/server/e2e — running E2E smoke tests...')
const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
const result = spawnSync(npmCmd, ['run', 'test:e2e:smoke'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
