/**
 * Cross-platform copy of out/ui/ → ~/.quoroom/app/ui/
 * Used by build:ui to make the latest UI available to the local quoroom binary.
 */
const { mkdirSync, cpSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

const src = join(__dirname, '../out/ui')
const dest = join(homedir(), '.quoroom', 'app', 'ui')

try {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
} catch (err) {
  // Non-fatal: if copy fails (e.g. permission issues in CI), continue silently
  process.exit(0)
}
