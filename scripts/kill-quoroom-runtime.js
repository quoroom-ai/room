#!/usr/bin/env node

const { execSync } = require('child_process')
const { resolve } = require('path')

const IS_WIN = process.platform === 'win32'
const dryRun = process.argv.includes('--dry-run')
const ROOM_ROOT = resolve(__dirname, '..')

/**
 * Match both globally installed Quoroom runtime processes and local room dev
 * runtime/watch processes that can survive crashed shells.
 */
const COMMAND_FRAGMENTS = [
  '/usr/local/lib/quoroom/lib/server.js',
  '/usr/local/lib/quoroom/lib/cli.js serve',
  '/usr/local/lib/quoroom/lib/cli.js mcp',
  `${ROOM_ROOT}/out/mcp/server.js`,
  `${ROOM_ROOT}/out/mcp/cli.js serve`,
  `${ROOM_ROOT}/out/mcp/cli.js mcp`,
  `${ROOM_ROOT}/scripts/dev-server.js`,
  `${ROOM_ROOT}/node_modules/.bin/vite --config src/ui/vite.config.ts`,
  `${ROOM_ROOT}/node_modules/.bin/vite build --watch --config src/ui/vite.config.ts`,
  'npm exec vite --config src/ui/vite.config.ts',
]

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readProcessTableUnix() {
  try {
    const out = execSync('ps -axo pid=,ppid=,command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
        if (!m) return null
        const pid = Number.parseInt(m[1], 10)
        const ppid = Number.parseInt(m[2], 10)
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null
        return { pid, ppid, command: m[3] }
      })
      .filter((row) => row !== null)
  } catch {
    return []
  }
}

function matchesTarget(command) {
  return COMMAND_FRAGMENTS.some(fragment => command.includes(fragment))
}

function collectDescendants(rootPids, table) {
  const byParent = new Map()
  for (const row of table) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row.pid)
  }

  const collected = new Set(rootPids)
  const queue = [...rootPids]
  while (queue.length > 0) {
    const current = queue.shift()
    const children = byParent.get(current) ?? []
    for (const child of children) {
      if (collected.has(child)) continue
      collected.add(child)
      queue.push(child)
    }
  }
  return collected
}

function listTargetsUnix() {
  const table = readProcessTableUnix()
  const ownPids = new Set([process.pid, process.ppid])
  const roots = table
    .filter(row => !ownPids.has(row.pid) && matchesTarget(row.command))
    .map(row => row.pid)
  if (roots.length === 0) return []

  const targetSet = collectDescendants(roots, table)
  return table
    .filter(row => targetSet.has(row.pid) && !ownPids.has(row.pid))
    .sort((a, b) => a.pid - b.pid)
}

function terminatePids(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited.
    }
  }
}

function mainUnix() {
  const targets = listTargetsUnix()
  if (targets.length === 0) {
    console.log('[kill-quoroom-runtime] no matching processes')
    return
  }

  const pids = [...new Set(targets.map(t => t.pid))]
  console.log(`[kill-quoroom-runtime] matched ${pids.length} process(es)`)
  for (const row of targets) {
    console.log(`  ${row.pid} ${row.command}`)
  }

  if (dryRun) {
    console.log('[kill-quoroom-runtime] dry-run mode; no signals sent')
    return
  }

  terminatePids(pids, 'SIGTERM')
  sleep(1200)

  const stillAliveAfterTerm = pids.filter(isAlive)
  if (stillAliveAfterTerm.length > 0) {
    terminatePids(stillAliveAfterTerm, 'SIGKILL')
    sleep(300)
  }

  const stillAlive = pids.filter(isAlive)
  if (stillAlive.length > 0) {
    console.error(`[kill-quoroom-runtime] failed to terminate PID(s): ${stillAlive.join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log('[kill-quoroom-runtime] cleanup complete')
}

function main() {
  if (IS_WIN) {
    console.log('[kill-quoroom-runtime] unsupported on Windows; skipping command-pattern cleanup')
    return
  }
  mainUnix()
}

if (require.main === module) {
  main()
}

