#!/usr/bin/env node

const { execSync } = require('child_process')

function parsePorts(args) {
  const ports = []
  for (const raw of args) {
    const value = Number.parseInt(raw, 10)
    if (Number.isFinite(value) && value > 0) ports.push(value)
  }
  return ports
}

function getListeningPids(port) {
  try {
    const out = execSync(`lsof -ti TCP:${port} -s TCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!out) return []
    return out
      .split('\n')
      .map((v) => Number.parseInt(v, 10))
      .filter((v) => Number.isFinite(v) && v > 0)
  } catch {
    return []
  }
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  return true
}

function main() {
  const ports = parsePorts(process.argv.slice(2))
  if (ports.length === 0) {
    console.log('Usage: node scripts/kill-ports.js <port> [port...]')
    process.exit(1)
  }

  for (const port of ports) {
    const pids = getListeningPids(port)
    if (pids.length === 0) {
      console.log(`[kill-ports] ${port}: free`)
      continue
    }

    const killed = []
    for (const pid of pids) {
      if (pid === process.pid) continue
      if (killPid(pid)) killed.push(pid)
    }
    console.log(`[kill-ports] ${port}: killed PID(s) ${killed.join(', ')}`)
  }
}

main()
