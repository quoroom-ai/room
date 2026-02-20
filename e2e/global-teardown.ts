/**
 * Playwright global teardown — stops the server.
 */

import { readFileSync, rmSync } from 'node:fs'

export default async function globalTeardown() {
  try {
    const state = JSON.parse(readFileSync('/tmp/quoroom-e2e.json', 'utf-8'))
    if (state.pid) {
      process.kill(state.pid, 'SIGTERM')
    }
  } catch {
    // Server already stopped
  }
  rmSync('/tmp/quoroom-e2e.json', { force: true })
  rmSync('/tmp/quoroom-e2e-test', { recursive: true, force: true })
}
