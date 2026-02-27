const { spawn } = require('child_process')
const { existsSync } = require('fs')
const { resolve } = require('path')

const IS_WIN = process.platform === 'win32'
const isolated = process.argv.includes('--isolated')

const children = new Map()
let shuttingDown = false
let exitCode = 0

function spawnNpm(args, options = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.includes('=') || value === undefined) continue
    env[key] = value
  }
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (!key || key.includes('=') || value === undefined) continue
      env[key] = String(value)
    }
  }
  if (IS_WIN) {
    return spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], {
      stdio: 'inherit',
      cwd: options.cwd ?? process.cwd(),
      env,
    })
  }

  return spawn('npm', args, {
    stdio: 'inherit',
    cwd: options.cwd ?? process.cwd(),
    env,
  })
}

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, options)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`npm ${args.join(' ')} exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`))
    })
  })
}

function terminateProcessTree(pid) {
  if (!pid) return
  if (IS_WIN) {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    killer.on('error', () => {})
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Process already exited.
  }
}

function startScript(scriptName, env = {}) {
  const child = spawnNpm(['run', scriptName], { env })
  children.set(scriptName, child)

  child.on('error', () => {
    if (!shuttingDown) shutdown(1)
  })

  child.on('exit', (code, signal) => {
    children.delete(scriptName)

    if (shuttingDown) {
      if (children.size === 0) process.exit(exitCode)
      return
    }

    const cleanExit = code === 0
    if (!cleanExit) {
      console.error(`[dev] "${scriptName}" exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`)
    } else {
      console.error(`[dev] "${scriptName}" exited unexpectedly.`)
    }
    shutdown(code && code > 0 ? code : 1)
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  exitCode = code

  for (const child of children.values()) {
    terminateProcessTree(child.pid)
  }

  if (children.size === 0) {
    process.exit(exitCode)
    return
  }

  const timer = setTimeout(() => process.exit(exitCode), IS_WIN ? 4000 : 2000)
  timer.unref()
}

async function main() {
  await runNpm(['run', 'kill:dev-runtime'])
  const cloudDir = resolve(__dirname, '../../cloud')
  const hasCloudProject = existsSync(cloudDir)
  const roomScript = IS_WIN
    ? (isolated ? 'dev:room:isolated:win' : 'dev:room:win')
    : (isolated ? 'dev:room:isolated' : 'dev:room')
  const cloudScript = IS_WIN ? 'dev:cloud:win' : 'dev:cloud'

  startScript('dev:links')
  startScript(roomScript)
  if (isolated) {
    if (hasCloudProject) {
      startScript(cloudScript)
    } else {
      console.warn(`[dev] Skipping cloud: missing project at ${cloudDir}`)
    }
    startScript('dev:ui', { VITE_API_PORT: '4700' })
  } else {
    if (hasCloudProject) {
      startScript(cloudScript)
    } else {
      console.warn(`[dev] Skipping cloud: missing project at ${cloudDir}`)
    }
  }
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  shutdown(1)
})
