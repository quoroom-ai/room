#!/usr/bin/env node

const { execSync } = require('child_process')

const IS_WIN = process.platform === 'win32'

function parsePorts(args) {
  const ports = []
  for (const raw of args) {
    const value = Number.parseInt(raw, 10)
    if (Number.isFinite(value) && value > 0) ports.push(value)
  }
  return ports
}

function getListeningPidsUnix(port) {
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

function getListeningPidsWindows(port) {
  // Primary: PowerShell Get-NetTCPConnection
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (out) {
      const pids = out.split(/\r?\n/).map((v) => Number.parseInt(v.trim(), 10)).filter((v) => Number.isFinite(v) && v > 0)
      if (pids.length > 0) return pids
    }
  } catch { /* fallback below */ }

  // Fallback: netstat + parse LISTENING lines
  try {
    const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
    const pids = new Set()
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const match = line.match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
      if (!match) continue
      const linePort = Number.parseInt(match[1], 10)
      const pid = Number.parseInt(match[2], 10)
      if (linePort === port && Number.isFinite(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  } catch {
    return []
  }
}

function getListeningPids(port) {
  return IS_WIN ? getListeningPidsWindows(port) : getListeningPidsUnix(port)
}

function killPid(pid) {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
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

// Export for testing; main() runs only when executed directly
module.exports = { parsePorts, getListeningPidsUnix, getListeningPidsWindows, getListeningPids, killPid }

if (require.main === module) {
  main()
}
