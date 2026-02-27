import { execSync, type ChildProcess } from 'node:child_process'

const managedChildPids = new Set<number>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function getUnixDescendants(rootPid: number): number[] {
  try {
    const output = execSync('ps -axo pid=,ppid=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })

    const byParent = new Map<number, number[]>()
    for (const raw of output.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const match = line.match(/^(\d+)\s+(\d+)$/)
      if (!match) continue
      const pid = Number.parseInt(match[1], 10)
      const ppid = Number.parseInt(match[2], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const list = byParent.get(ppid) ?? []
      list.push(pid)
      byParent.set(ppid, list)
    }

    const descendants: number[] = []
    const queue = [rootPid]
    const seen = new Set<number>()
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = byParent.get(current) ?? []
      for (const child of children) {
        if (seen.has(child)) continue
        seen.add(child)
        descendants.push(child)
        queue.push(child)
      }
    }
    return descendants
  } catch {
    return []
  }
}

function killPidTree(pid: number, force: boolean): void {
  if (!Number.isFinite(pid) || pid <= 0) return

  if (process.platform === 'win32') {
    const cmd = force
      ? `taskkill /PID ${pid} /T /F`
      : `taskkill /PID ${pid} /T`
    try {
      execSync(cmd, { stdio: 'ignore' })
    } catch {
      // Best effort.
    }
    return
  }

  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM'
  const descendants = getUnixDescendants(pid)
  for (const childPid of descendants.reverse()) {
    try { process.kill(childPid, signal) } catch { /* best effort */ }
  }
  try { process.kill(pid, signal) } catch { /* best effort */ }
}

export function registerManagedChildProcess(child: ChildProcess): () => void {
  const pid = child.pid
  if (!pid || !Number.isFinite(pid) || pid <= 0) return () => {}

  managedChildPids.add(pid)

  let removed = false
  const unregister = () => {
    if (removed) return
    removed = true
    managedChildPids.delete(pid)
  }

  child.once('close', unregister)
  child.once('exit', unregister)
  child.once('error', unregister)
  return unregister
}

export function getManagedChildPids(): number[] {
  return [...managedChildPids].filter((pid) => Number.isFinite(pid) && pid > 0)
}

export async function terminateManagedChildProcesses(graceMs = 1_500): Promise<void> {
  const rootPids = getManagedChildPids()
  if (rootPids.length === 0) return

  for (const pid of rootPids) killPidTree(pid, false)
  await sleep(Math.max(100, graceMs))

  for (const pid of rootPids) {
    if (isPidAlive(pid)) killPidTree(pid, true)
  }

  managedChildPids.clear()
}
