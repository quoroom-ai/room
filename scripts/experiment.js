#!/usr/bin/env node
/**
 * Queen Experiment Runner — verbose/transparent mode
 *
 * Creates an isolated environment (separate DB + port) with 4 rooms using
 * different models, runs queen cycles, and streams ALL activity live.
 *
 * Usage:
 *   node scripts/experiment.js [--cycles N] [--goal "..."] [--keep-db]
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY and OPENAI_API_KEY in /Users/vasily/projects/cloud/.env
 *   - claude and codex CLI available for CLI models
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, mkdirSync, rmSync } = require('fs')
const path = require('path')
const http = require('http')

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = 3710
const CYCLE_GAP_MS = 5000  // 5s between cycles for fast iteration
const MAX_TURNS = 30
const TIMEOUT_MS = 10 * 60 * 1000  // 10 min max experiment time

const DEFAULT_GOAL = 'Build a plan to launch an AI consulting service. Research market rates online. Store findings in memory. Create sub-goals for pricing and outreach. Message the keeper with your strategy and budget needs. Propose collaborations to other rooms. Report progress every cycle.'

const ALL_MODELS = [
  { label: 'claude', model: 'claude', type: 'cli' },
  { label: 'codex', model: 'codex', type: 'cli' },
  { label: 'anth-api', model: 'anthropic:claude-sonnet-4-6', type: 'api', keyEnv: 'ANTHROPIC_API_KEY', credName: 'anthropic_api_key' },
  { label: 'oai-api', model: 'openai:gpt-4o', type: 'api', keyEnv: 'OPENAI_API_KEY', credName: 'openai_api_key' },
]

// Color codes
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
}
const ROOM_COLORS = [C.cyan, C.yellow, C.magenta, C.green]

function log(prefix, color, msg) {
  const ts = new Date().toISOString().substring(11, 19)
  console.log(`${C.dim}${ts}${C.reset} ${color}${prefix}${C.reset} ${msg}`)
}

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : null
}
const numCycles = parseInt(getArg('--cycles') || '3', 10)
const goal = getArg('--goal') || DEFAULT_GOAL
const keepDb = args.includes('--keep-db')
const modelFilter = getArg('--models')  // e.g. "api" for API-only, "cli" for CLI-only, or comma-separated labels

const MODELS = modelFilter
  ? ALL_MODELS.filter(m => {
    if (modelFilter === 'api') return m.type === 'api'
    if (modelFilter === 'cli') return m.type === 'cli'
    const labels = modelFilter.split(',')
    return labels.some(l => m.label.includes(l) || m.model.includes(l))
  })
  : ALL_MODELS

// ─── Load API keys from cloud/.env ───────────────────────────────────────────

function loadCloudEnv() {
  const envPath = '/Users/vasily/projects/cloud/.env'
  if (!existsSync(envPath)) {
    console.error('ERROR: cloud/.env not found at', envPath)
    process.exit(1)
  }
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  const env = {}
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.+)$/)
    if (match) env[match[1]] = match[2]
  }
  return env
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' }
    }
    if (token) opts.headers['Authorization'] = `Bearer ${token}`
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch { parsed = data }
        resolve({ status: res.statusCode, data: parsed })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function api(method, urlPath, body, token) {
  const res = await request(method, urlPath, body, token)
  const short = urlPath.length > 50 ? urlPath.substring(0, 47) + '...' : urlPath
  const ok = res.status >= 200 && res.status < 300
  const statusColor = ok ? C.green : C.red
  log('API', C.dim, `${method} ${short} ${statusColor}${res.status}${C.reset}${!ok ? ' ' + JSON.stringify(res.data).substring(0, 100) : ''}`)
  return res
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Build ───────────────────────────────────────────────────────────────────

const EXTERNALS = ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'playwright', 'playwright-core']
const PROJECT_ROOT = path.resolve(__dirname, '..')
const { version } = require(path.join(PROJECT_ROOT, 'package.json'))

function build() {
  log('BUILD', C.blue, 'Compiling server with esbuild...')
  const ext = EXTERNALS.map(e => `--external:${e}`).join(' ')
  const define = `--define:__APP_VERSION__='"${version}"'`
  const common = `--bundle --platform=node --target=node18 ${ext} ${define}`

  execSync(`npx esbuild src/mcp/server.ts ${common} --outfile=out/mcp/server.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  execSync(`npx esbuild src/cli/index.ts ${common} --outfile=out/mcp/cli.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  execSync(`npx esbuild src/server/index.ts ${common} --external:ws --outfile=out/mcp/api-server.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  log('BUILD', C.blue, 'Done.')
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

let serverProcess = null
let dataDir = null
let dbPath = null

function startServer(env) {
  // Kill any leftover process on our port
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-experiment-${ts}`
  dbPath = path.join(dataDir, 'data.db')
  mkdirSync(dataDir, { recursive: true })

  log('SERVER', C.green, `Starting on :${PORT}`)
  log('SERVER', C.green, `DB: ${dbPath}`)

  serverProcess = spawn('node', [path.join(PROJECT_ROOT, 'out/mcp/cli.js'), 'serve', '--port', String(PORT)], {
    env: {
      ...process.env,
      ...env,
      QUOROOM_DB_PATH: dbPath,
      QUOROOM_DATA_DIR: dataDir,
      QUOROOM_SKIP_MCP_REGISTER: '1',
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Stream server output live
  serverProcess.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      log('SERVER', C.dim, line)
    }
  })
  serverProcess.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      log('SERVER', C.dim, line)
    }
  })
  serverProcess.on('exit', (code) => {
    if (code && code !== 0) log('SERVER', C.red, `Exited with code ${code}`)
  })

  return serverProcess
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now()
  const tokenFile = path.join(dataDir, 'api.token')

  // Wait for token file + DB
  while (Date.now() - start < maxWaitMs) {
    if (existsSync(tokenFile) && existsSync(dbPath)) break
    await sleep(500)
  }
  if (!existsSync(tokenFile)) throw new Error('Server did not start — no token file at ' + tokenFile)

  // Wait for HTTP
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await request('GET', '/api/rooms', null, readFileSync(tokenFile, 'utf-8').trim())
      if (res.status === 200 || res.status === 401) {
        log('SERVER', C.green, `Ready (${((Date.now() - start) / 1000).toFixed(1)}s)`)
        return true
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('Server did not respond within timeout')
}

function getAuthToken() {
  const tokenFile = path.join(dataDir, 'api.token')
  if (!existsSync(tokenFile)) throw new Error('Auth token file not found: ' + tokenFile)
  return readFileSync(tokenFile, 'utf-8').trim()
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

// ─── Setup rooms ─────────────────────────────────────────────────────────────

async function setupRooms(token, apiKeys) {
  const rooms = []

  for (let i = 0; i < MODELS.length; i++) {
    const m = MODELS[i]
    const color = ROOM_COLORS[i % ROOM_COLORS.length]
    log(m.label, color, `Creating room (model: ${m.model})...`)

    // Create room
    const res = await api('POST', '/api/rooms', { name: `exp-${m.label}`, goal }, token)
    if (res.status !== 200 && res.status !== 201) {
      log(m.label, C.red, `FAILED to create room: ${JSON.stringify(res.data).substring(0, 200)}`)
      continue
    }
    const room = res.data.room || res.data
    const queen = res.data.queen
    const wallet = res.data.wallet

    log(m.label, color, `Room #${room.id} created, queen #${queen.id}, wallet: ${wallet?.address?.substring(0, 10)}...`)

    // Set queen model
    await api('PATCH', `/api/workers/${queen.id}`, { model: m.model }, token)

    // Set room-level config
    await api('PATCH', `/api/rooms/${room.id}`, {
      workerModel: m.model,
      queenCycleGapMs: CYCLE_GAP_MS,
      queenMaxTurns: MAX_TURNS
    }, token)

    // Set API credentials if needed
    if (m.type === 'api' && m.credName && apiKeys[m.keyEnv]) {
      await api('POST', `/api/rooms/${room.id}/credentials`, {
        name: m.credName,
        type: 'api_key',
        value: apiKeys[m.keyEnv]
      }, token)
      log(m.label, color, `API key ${m.credName} configured`)
    }

    rooms.push({ ...m, roomId: room.id, queenId: queen.id, color })
    log(m.label, color, 'Ready.')
  }

  return rooms
}

// ─── Live cycle monitoring ──────────────────────────────────────────────────

async function runCycles(token, rooms) {
  const Database = require('better-sqlite3')

  // Start all queens
  console.log('')
  log('EXPERIMENT', C.bold, `Starting ${rooms.length} queens for ${numCycles} cycle(s) each...`)
  console.log('')

  for (const r of rooms) {
    const res = await api('POST', `/api/rooms/${r.roomId}/queen/start`, {}, token)
    log(r.label, r.color, res.status === 200 ? 'Queen started' : `Start failed: ${JSON.stringify(res.data)}`)
  }

  console.log('')
  log('EXPERIMENT', C.bold, 'Monitoring cycles live...')
  console.log('─'.repeat(80))

  const start = Date.now()
  const lastLogSeq = {}  // per cycle_id: last seq we printed
  const printedCycles = new Set()  // cycle IDs we printed the header for
  const completedCycles = new Set()  // cycle IDs we printed the completion for

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(2000)

    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    let allDone = true

    for (const r of rooms) {
      // Get all cycles for this room
      const cycles = db.prepare(
        'SELECT id, status, duration_ms, input_tokens, output_tokens, error_message FROM worker_cycles WHERE room_id = ? ORDER BY id'
      ).all(r.roomId)

      const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length
      if (done < numCycles) allDone = false

      // Stream logs for each active/completed cycle
      for (const cycle of cycles) {
        // Print cycle start header
        if (!printedCycles.has(cycle.id)) {
          printedCycles.add(cycle.id)
          const cycleNum = cycles.indexOf(cycle) + 1
          console.log('')
          log(r.label, r.color, `${C.bold}── Cycle ${cycleNum} started (cycle_id=${cycle.id}) ──${C.reset}`)
        }

        // Get new log entries
        const lastSeq = lastLogSeq[cycle.id] || 0
        const logs = db.prepare(
          'SELECT seq, entry_type, content FROM cycle_logs WHERE cycle_id = ? AND seq > ? ORDER BY seq'
        ).all(cycle.id, lastSeq)

        for (const entry of logs) {
          lastLogSeq[cycle.id] = entry.seq
          const content = (entry.content || '').replace(/\n/g, '\n' + ' '.repeat(28))

          switch (entry.entry_type) {
            case 'tool_call':
              log(r.label, r.color, `  -> ${C.cyan}${content.substring(0, 200)}${C.reset}`)
              break
            case 'tool_result':
              // Truncate long results
              log(r.label, r.color, `  <- ${C.dim}${content.substring(0, 300)}${C.reset}`)
              break
            case 'assistant_text':
              log(r.label, r.color, `  ${C.white}${content.substring(0, 400)}${C.reset}`)
              break
            case 'error':
              log(r.label, C.red, `  ERROR: ${content.substring(0, 300)}`)
              break
            default:
              log(r.label, r.color, `  [${entry.entry_type}] ${content.substring(0, 200)}`)
          }
        }

        // Print cycle completion
        if ((cycle.status === 'completed' || cycle.status === 'failed') && !completedCycles.has(cycle.id)) {
          completedCycles.add(cycle.id)
          const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
          const tokIn = cycle.input_tokens || '?'
          const tokOut = cycle.output_tokens || '?'
          if (cycle.status === 'completed') {
            log(r.label, r.color, `${C.bold}── Cycle done: ${dur}s, tokens: ${tokIn}/${tokOut} ──${C.reset}`)
          } else {
            log(r.label, C.red, `${C.bold}── Cycle FAILED: ${cycle.error_message || 'unknown'} ──${C.reset}`)
          }
        }
      }
    }

    db.close()

    if (allDone) {
      console.log('')
      log('EXPERIMENT', C.green + C.bold, 'All cycles complete!')
      return
    }
  }

  console.log('')
  log('EXPERIMENT', C.red, 'TIMEOUT — some cycles did not complete')
}

// ─── Collect & print results ────────────────────────────────────────────────

function collectResults(rooms) {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const results = []

  for (const r of rooms) {
    const cycles = db.prepare(
      'SELECT id, duration_ms, input_tokens, output_tokens, status, error_message FROM worker_cycles WHERE room_id = ? ORDER BY id'
    ).all(r.roomId)

    const completedCycles = cycles.filter(c => c.status === 'completed')
    const totalDuration = completedCycles.reduce((s, c) => s + (c.duration_ms || 0), 0)
    const avgDuration = completedCycles.length > 0 ? totalDuration / completedCycles.length : 0
    const totalInputTokens = completedCycles.reduce((s, c) => s + (c.input_tokens || 0), 0)
    const totalOutputTokens = completedCycles.reduce((s, c) => s + (c.output_tokens || 0), 0)

    // Tool calls
    const cycleIds = completedCycles.map(c => c.id)
    let toolCalls = 0
    const uniqueTools = new Set()
    for (const cid of cycleIds) {
      const calls = db.prepare(
        "SELECT content FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'"
      ).all(cid)
      toolCalls += calls.length
      for (const call of calls) {
        const match = call.content?.match(/(?:→ |Using )(\w+)/)
        if (match) uniqueTools.add(match[1])
      }
    }

    // Keeper messages
    const keeperMsgs = db.prepare(
      'SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND from_agent_id = ?'
    ).get(r.roomId, r.queenId)

    // Inter-room messages
    const interRoomMsgs = db.prepare(
      "SELECT COUNT(*) as cnt FROM room_messages WHERE room_id = ? AND direction = 'outbound'"
    ).get(r.roomId)

    // Goals
    const goals = db.prepare('SELECT id, status, progress FROM goals WHERE room_id = ?').all(r.roomId)
    const goalsCreated = goals.length
    const goalsCompleted = goals.filter(g => g.status === 'completed').length
    const maxProgress = goals.length > 0 ? Math.max(...goals.map(g => g.progress ?? 0)) : 0

    // Workers created (excluding queen)
    const workersCreated = db.prepare(
      'SELECT COUNT(*) as cnt FROM workers WHERE room_id = ? AND id != ?'
    ).get(r.roomId, r.queenId)

    // Tasks
    const tasksScheduled = db.prepare(
      'SELECT COUNT(*) as cnt FROM tasks WHERE room_id = ?'
    ).get(r.roomId)

    // Memories
    const memories = db.prepare(
      'SELECT COUNT(*) as cnt FROM entities WHERE room_id = ?'
    ).get(r.roomId)

    // Decisions
    const decisions = db.prepare(
      'SELECT COUNT(*) as cnt FROM quorum_decisions WHERE room_id = ?'
    ).get(r.roomId)

    // Wallet
    const wallet = db.prepare('SELECT id FROM wallets WHERE room_id = ?').get(r.roomId)
    let walletBalance = '$0'
    if (wallet) {
      const received = db.prepare(
        "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('receive', 'fund')"
      ).get(wallet.id)
      const spent = db.prepare(
        "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM wallet_transactions WHERE wallet_id = ? AND type IN ('send', 'purchase')"
      ).get(wallet.id)
      walletBalance = '$' + (received.total - spent.total).toFixed(2)
    }

    // Revenue actions
    let revenueActions = 0
    const moneyRx = /revenue|pricing|payment|budget|fund|money|earn|cost|charge|fee|invoice|profit|income/i
    const escTexts = db.prepare(
      'SELECT question FROM escalations WHERE room_id = ? AND from_agent_id = ?'
    ).all(r.roomId, r.queenId)
    for (const e of escTexts) { if (moneyRx.test(e.question)) revenueActions++ }
    const msgTexts = db.prepare(
      "SELECT subject, body FROM room_messages WHERE room_id = ? AND direction = 'outbound'"
    ).all(r.roomId)
    for (const m of msgTexts) { if (moneyRx.test(m.subject) || moneyRx.test(m.body)) revenueActions++ }

    const errors = cycles.filter(c => c.status === 'failed').length

    results.push({
      label: r.label,
      totalDuration: (totalDuration / 1000).toFixed(1) + 's',
      avgDuration: (avgDuration / 1000).toFixed(1) + 's',
      tokens: `${fmtK(totalInputTokens)}/${fmtK(totalOutputTokens)}`,
      toolCalls,
      uniqueTools: uniqueTools.size,
      keeperMsgs: keeperMsgs.cnt,
      interRoomMsgs: interRoomMsgs.cnt,
      goals: `${goalsCreated}/${goalsCompleted}`,
      workersCreated: workersCreated.cnt,
      tasksScheduled: tasksScheduled.cnt,
      memories: memories.cnt,
      decisions: decisions.cnt,
      walletBalance,
      revenueActions,
      errors,
      goalProgress: Math.round(maxProgress * 100) + '%'
    })
  }

  db.close()
  return results
}

function fmtK(n) {
  if (!n || n === 0) return '?'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function printResults(results) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  console.log('\n' + '='.repeat(74))
  console.log(`  EXPERIMENT RESULTS - ${now}`)
  console.log(`  Goal: "${goal.substring(0, 70)}${goal.length > 70 ? '...' : ''}"`)
  console.log(`  Cycles: ${numCycles} per room`)
  console.log('='.repeat(74))

  const metrics = [
    ['Total duration', r => r.totalDuration],
    ['Avg cycle duration', r => r.avgDuration],
    ['Tokens (in/out)', r => r.tokens],
    ['Tool calls', r => String(r.toolCalls)],
    ['Unique tools used', r => String(r.uniqueTools)],
    ['Keeper messages', r => String(r.keeperMsgs)],
    ['Inter-room messages', r => String(r.interRoomMsgs)],
    ['Goals (created/done)', r => r.goals],
    ['Workers created', r => String(r.workersCreated)],
    ['Tasks scheduled', r => String(r.tasksScheduled)],
    ['Memories stored', r => String(r.memories)],
    ['Decisions proposed', r => String(r.decisions)],
    ['Wallet balance', r => r.walletBalance],
    ['Revenue actions', r => String(r.revenueActions)],
    ['Errors', r => String(r.errors)],
    ['Goal progress', r => r.goalProgress],
  ]

  const labelW = 22
  const colW = 12
  const labels = results.map(r => r.label)

  // Header
  console.log('')
  const sep = '-'
  console.log('  ' + pad('Metric', labelW) + labels.map(l => pad(l, colW)).join(''))
  console.log('  ' + sep.repeat(labelW) + labels.map(() => sep.repeat(colW)).join(''))

  // Rows
  for (const [name, fn] of metrics) {
    const vals = results.map(fn)
    console.log('  ' + pad(name, labelW) + vals.map(v => pad(v, colW)).join(''))
  }

  console.log('')
}

function pad(s, w) {
  if (s.length >= w) return s.substring(0, w - 1) + ' '
  return s + ' '.repeat(w - s.length)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log(`${C.bold}Queen Experiment${C.reset} — ${numCycles} cycles, ${MODELS.length} models`)
  console.log(`Goal: "${goal.substring(0, 100)}${goal.length > 100 ? '...' : ''}"`)
  console.log('')

  // 1. Load API keys
  const cloudEnv = loadCloudEnv()
  const apiKeys = {}
  for (const m of MODELS) {
    if (m.keyEnv && cloudEnv[m.keyEnv]) {
      apiKeys[m.keyEnv] = cloudEnv[m.keyEnv]
      log('KEYS', C.green, `${m.keyEnv} loaded (${m.label})`)
    } else if (m.keyEnv) {
      log('KEYS', C.red, `${m.keyEnv} NOT FOUND — ${m.label} may fail`)
    }
  }

  // 2. Build
  build()

  // 3. Start server
  startServer({
    ANTHROPIC_API_KEY: apiKeys.ANTHROPIC_API_KEY || '',
    OPENAI_API_KEY: apiKeys.OPENAI_API_KEY || '',
  })
  await waitForServer()

  // 4. Get auth token
  const token = getAuthToken()
  log('AUTH', C.green, `Token: ${token.substring(0, 10)}...`)

  // 5. Setup rooms
  console.log('')
  log('SETUP', C.bold, 'Creating experiment rooms...')
  const rooms = await setupRooms(token, apiKeys)
  if (rooms.length === 0) {
    log('SETUP', C.red, 'No rooms created! Aborting.')
    stopServer()
    process.exit(1)
  }

  // 6. Run cycles with live monitoring
  await runCycles(token, rooms)

  // 7. Collect and print results
  const results = collectResults(rooms)
  printResults(results)

  // 8. Cleanup
  stopServer()
  if (keepDb) {
    log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
  } else {
    try { rmSync(dataDir, { recursive: true }) } catch {}
    log('CLEANUP', C.dim, 'Temp DB cleaned up.')
  }
}

main().catch(err => {
  console.error(`\n${C.red}Experiment failed: ${err.message}${C.reset}`)
  if (err.stack) console.error(C.dim + err.stack + C.reset)
  stopServer()
  process.exit(1)
})
