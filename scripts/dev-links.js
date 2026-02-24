#!/usr/bin/env node

const net = require('net')

const TARGETS = [
  { host: '127.0.0.1', port: 3715 },
  { host: '127.0.0.1', port: 4700 },
]

const MAX_WAIT_MS = 180000
const RETRY_MS = 500
const CONNECT_TIMEOUT_MS = 400

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function allReady() {
  const checks = await Promise.all(TARGETS.map((t) => isListening(t.host, t.port)))
  return checks.every(Boolean)
}

function printLinks() {
  console.log('\n[dev] Services ready')
  console.log('Cloud landing:   http://127.0.0.1:3715/')
  console.log('Cloud dashboard: http://127.0.0.1:3715/app')
  console.log('Local dashboard: http://localhost:4700')
  console.log('Vite dev (HMR):  http://localhost:5173')
  console.log('')
}

async function main() {
  const startedAt = Date.now()

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    if (await allReady()) {
      printLinks()
      return
    }
    await sleep(RETRY_MS)
  }

  console.log('\n[dev] Links not printed yet (services did not become ready in time).\n')
}

main().catch(() => {
  // Keep this helper non-fatal for dev startup.
})
