#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')

const HOME = os.homedir()
const ROOT = path.resolve(__dirname, '..')

const MODES = [
  { name: 'release', dataDir: path.join(HOME, '.quoroom'), port: 3700 },
  { name: 'dev', dataDir: path.join(HOME, '.quoroom-dev'), port: 4700 },
]

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function statInfo(p) {
  if (!exists(p)) return null
  const s = fs.statSync(p)
  return {
    size: s.size,
    mtime: s.mtime,
  }
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function readTrimmed(p) {
  if (!exists(p)) return null
  return fs.readFileSync(p, 'utf8').trim()
}

function getListeners(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!out) return []

    const lines = out.split('\n').slice(1)
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/)
      const command = parts[0] || 'unknown'
      const pid = Number(parts[1] || 0)
      const name = parts[parts.length - 1] || ''
      let fullCommand = ''
      if (pid) {
        try {
          fullCommand = execSync(`ps -p ${pid} -o command=`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim()
        } catch {
          fullCommand = ''
        }
      }
      return { command, pid, name, fullCommand }
    })
  } catch {
    return []
  }
}

function readJsonSafe(p) {
  if (!exists(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return 'invalid_json'
  }
}

function getMcpDbPath(configPath) {
  const cfg = readJsonSafe(configPath)
  if (!cfg || cfg === 'invalid_json') return null
  return cfg?.mcpServers?.quoroom?.env?.QUOROOM_DB_PATH || null
}

function fmtDate(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function printMode(mode) {
  const dbPath = path.join(mode.dataDir, 'data.db')
  const db = statInfo(dbPath)
  const apiPort = readTrimmed(path.join(mode.dataDir, 'api.port'))
  const token = readTrimmed(path.join(mode.dataDir, 'api.token'))
  const listeners = getListeners(mode.port)

  console.log(`\n[${mode.name.toUpperCase()}]`)
  console.log(`data dir: ${mode.dataDir}`)
  if (db) {
    console.log(`db: ${dbPath} (${humanBytes(db.size)}, updated ${fmtDate(db.mtime)})`)
  } else {
    console.log(`db: ${dbPath} (missing)`)
  }
  console.log(`api.port file: ${apiPort || '(missing)'}`)
  console.log(`api.token file: ${token ? `${token.slice(0, 8)}...` : '(missing)'}`)

  if (listeners.length === 0) {
    console.log(`listen ${mode.port}: no process`)
  } else {
    for (const l of listeners) {
      console.log(`listen ${mode.port}: pid ${l.pid} ${l.command} (${l.name})`)
      if (l.fullCommand) console.log(`  cmd: ${l.fullCommand}`)
    }
  }

  return { listeners, dbPath }
}

function main() {
  console.log('Quoroom Split Doctor')
  console.log('--------------------')

  const release = printMode(MODES[0])
  const dev = printMode(MODES[1])

  const claudePath = path.join(HOME, '.claude.json')
  const claudeDbPath = getMcpDbPath(claudePath)
  console.log('\n[MCP CONFIG]')
  console.log(`file: ${claudePath}${exists(claudePath) ? '' : ' (missing)'}`)
  if (claudeDbPath) {
    console.log(`quoroom MCP DB: ${claudeDbPath}`)
  } else if (readJsonSafe(claudePath) === 'invalid_json') {
    console.log('quoroom MCP DB: (invalid JSON)')
  } else {
    console.log('quoroom MCP DB: (not set)')
  }

  const issues = []

  for (const l of release.listeners) {
    if (l.fullCommand && l.fullCommand.includes(ROOT)) {
      issues.push('Port 3700 is served by a source/dev process from this repo.')
      break
    }
  }

  if (claudeDbPath && claudeDbPath.includes('.quoroom-dev')) {
    issues.push('MCP config points to .quoroom-dev (dev DB), not release DB.')
  }

  if (release.listeners.length > 0 && dev.listeners.length > 0) {
    issues.push('Both release and dev ports are active at the same time.')
  }

  console.log('\n[ASSESSMENT]')
  if (issues.length === 0) {
    console.log('OK: no obvious mixing detected.')
  } else {
    for (const issue of issues) console.log(`WARN: ${issue}`)
  }

  console.log('\n[RECOMMENDED]')
  console.log('dev: npm run dev:room          # isolated (~/.quoroom-dev, :4700)')
  console.log('release: launch installed app  # release (~/.quoroom, :3700)')
  console.log('shared mode only if needed: npm run dev:room:shared')
}

main()
