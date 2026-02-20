/**
 * Playwright global setup — starts the Quoroom server once for all tests.
 * Writes token to /tmp/quoroom-e2e.json for test files to read.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'

const PORT = 3701

export default async function globalSetup() {
  // Clean previous data
  const { rmSync } = await import('node:fs')
  rmSync('/tmp/quoroom-e2e-test', { recursive: true, force: true })

  const proc: ChildProcess = await new Promise((resolve, reject) => {
    const child = spawn('node', ['out/mcp/cli.js', 'serve', String(PORT)], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QUOROOM_DATA_DIR: '/tmp/quoroom-e2e-test', QUOROOM_SKIP_MCP_REGISTER: '1' }
    })

    let started = false

    child.stderr!.on('data', (data: Buffer) => {
      const line = data.toString()
      if (line.includes('API server started') && !started) {
        started = true
        resolve(child)
      }
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (!started) reject(new Error(`Server exited with code ${code}`))
    })

    setTimeout(() => {
      if (!started) {
        child.kill()
        reject(new Error('Server start timeout'))
      }
    }, 10_000)
  })

  // Read agent token from file (written by server on startup)
  const agentToken = readFileSync('/tmp/quoroom-e2e-test/api.token', 'utf-8').trim()

  // Fetch user token via handshake (handshake returns user-level token)
  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/handshake`)
  const { token: userToken } = await res.json() as { token: string }

  // Write state for tests and teardown
  mkdirSync('/tmp/quoroom-e2e-test', { recursive: true })
  writeFileSync('/tmp/quoroom-e2e.json', JSON.stringify({
    pid: proc.pid, token: agentToken, userToken, port: PORT
  }))
}
