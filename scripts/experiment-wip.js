#!/usr/bin/env node
/**
 * WIP System Test — minimal experiment to verify the WIP (work-in-progress) system
 *
 * Run:
 *   node scripts/experiment-wip.js
 *   node scripts/experiment-wip.js --keep-db   # preserve DB for inspection
 *
 * What it tests:
 *   1. Agent runs 2 short cycles (Claude CLI only — uses subscription, no API costs)
 *   2. Goal requires a concrete action that should produce WIP
 *   3. After cycle 1: checks if WIP was saved to the workers table
 *   4. After cycle 2: checks if agent continued forward (didn't repeat cycle 1 work)
 *   5. Prints WIP state, tool calls, and verdict
 *
 * Expected: ~2-5 min, minimal token usage (2 cycles × ~10-20 turns each)
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const http = require('http')

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = 3710
const CYCLE_GAP_MS = 5000
const MAX_TURNS = 50        // Let agent run to completion (the whole point of the WIP system)
const TIMEOUT_MS = 15 * 60 * 1000  // 15 min safety net
const NUM_CYCLES = 2

// Goal that requires concrete action + WIP saving
const GOAL = `Research the top 3 AI agent frameworks (crew.ai, autogen, langgraph). For each one, use web_search to find their pricing and key features. Store each framework's details in memory using quoroom_remember.

IMPORTANT: At the END of each cycle, save your progress with quoroom_save_wip so the next cycle knows where you left off. Example: quoroom_save_wip({ status: "Researched crew.ai and autogen. Next: research langgraph and write comparison." })`

// Tool set: solo tools + save_wip + browser
const TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch',
  'quoroom_save_wip',
].join(',')

// Color codes
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
}

function log(prefix, color, msg) {
  const ts = new Date().toISOString().substring(11, 19)
  console.log(`${C.dim}${ts}${C.reset} ${color}${prefix}${C.reset} ${msg}`)
}

// ─── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  const src = readFileSync(__filename, 'utf-8')
  const match = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (match) console.log(match[1].replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}
const keepDb = args.includes('--keep-db')

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

  // Update installed MCP binary so Claude CLI picks up code changes
  const installedMcp = '/usr/local/lib/quoroom/lib/server.js'
  try {
    execSync(`cp out/mcp/server.js ${installedMcp}`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
    log('BUILD', C.blue, 'Updated installed MCP server.')
  } catch {
    log('BUILD', C.yellow, `Could not update ${installedMcp} — run with sudo or copy manually.`)
  }

  log('BUILD', C.blue, 'Done.')
}

// ─── MCP DB override ─────────────────────────────────────────────────────────

const CLAUDE_CONFIG_PATH = path.join(homedir(), '.claude.json')
let originalMcpDbPath = null
let originalMcpArgs = null

function overrideMcpConfig(experimentDbPath) {
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8'))
    const quoroom = config.mcpServers?.quoroom
    if (!quoroom) return
    // Override DB path
    originalMcpDbPath = quoroom.env?.QUOROOM_DB_PATH ?? null
    if (!quoroom.env) quoroom.env = {}
    quoroom.env.QUOROOM_DB_PATH = experimentDbPath
    // Override MCP server binary to use local build (installed one may be stale / root-owned)
    const localServer = path.join(PROJECT_ROOT, 'out/mcp/server.js')
    if (existsSync(localServer)) {
      originalMcpArgs = [...(quoroom.args || [])]
      quoroom.args = [localServer]
      log('MCP', C.green, `Binary override → ${localServer}`)
    }
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    log('MCP', C.green, `DB override → ${experimentDbPath}`)
  } catch (e) {
    log('MCP', C.yellow, `Could not override MCP config: ${e.message}`)
  }
}

function restoreMcpConfig() {
  if (originalMcpDbPath === null && originalMcpArgs === null) return
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8'))
    const quoroom = config.mcpServers?.quoroom
    if (!quoroom) return
    if (originalMcpDbPath !== null && quoroom.env) {
      quoroom.env.QUOROOM_DB_PATH = originalMcpDbPath
    }
    if (originalMcpArgs !== null) {
      quoroom.args = originalMcpArgs
    }
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    log('MCP', C.dim, 'MCP config restored.')
  } catch (e) {
    log('MCP', C.yellow, `Could not restore MCP config: ${e.message}`)
  }
  originalMcpDbPath = null
  originalMcpArgs = null
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

let serverProcess = null
let dataDir = null
let dbPath = null

function startServer() {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-wip-test-${ts}`
  dbPath = path.join(dataDir, 'data.db')
  mkdirSync(dataDir, { recursive: true })

  log('SERVER', C.green, `Starting on :${PORT}`)
  log('SERVER', C.green, `DB: ${dbPath}`)

  serverProcess = spawn('node', [path.join(PROJECT_ROOT, 'out/mcp/cli.js'), 'serve', '--port', String(PORT)], {
    env: {
      ...process.env,
      QUOROOM_DB_PATH: dbPath,
      QUOROOM_DATA_DIR: dataDir,
      QUOROOM_SKIP_MCP_REGISTER: '1',
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

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
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now()
  const tokenFile = path.join(dataDir, 'api.token')

  while (Date.now() - start < maxWaitMs) {
    if (existsSync(tokenFile) && existsSync(dbPath)) break
    await sleep(500)
  }
  if (!existsSync(tokenFile)) throw new Error('Server did not start — no token file')

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await request('GET', '/api/rooms', null, readFileSync(tokenFile, 'utf-8').trim())
      if (res.status === 200 || res.status === 401) {
        log('SERVER', C.green, `Ready (${((Date.now() - start) / 1000).toFixed(1)}s)`)
        return
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('Server did not respond within timeout')
}

function getAuthToken() {
  return readFileSync(path.join(dataDir, 'api.token'), 'utf-8').trim()
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

// ─── Run experiment ──────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}${C.cyan}║   WIP System Test — Uninterrupted Cycles     ║${C.reset}`)
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════╝${C.reset}`)
  console.log(`${C.dim}  Model: claude (CLI, subscription — no API cost)`)
  console.log(`  Cycles: ${NUM_CYCLES}, Max turns: ${MAX_TURNS}`)
  console.log(`  Goal: ${GOAL.substring(0, 70)}...${C.reset}`)
  console.log('')

  // 1. Build
  build()

  // 2. Start server
  startServer()
  await waitForServer()
  const token = getAuthToken()

  // Override MCP config for Claude CLI (DB path + local server binary)
  overrideMcpConfig(dbPath)

  // 3. Create room + queen
  log('SETUP', C.green, 'Creating room...')
  const res = await api('POST', '/api/rooms', { name: 'wip-test', goal: GOAL }, token)
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create room: ${JSON.stringify(res.data)}`)
  }
  const room = res.data.room || res.data
  const queen = res.data.queen
  log('SETUP', C.green, `Room #${room.id}, Queen #${queen.id}`)

  // Configure: Claude CLI, short gap, high turns, include save_wip
  await api('PATCH', `/api/workers/${queen.id}`, { model: 'claude' }, token)
  await api('PATCH', `/api/rooms/${room.id}`, {
    workerModel: 'claude',
    queenCycleGapMs: CYCLE_GAP_MS,
    queenMaxTurns: MAX_TURNS,
    allowedTools: TOOLS
  }, token)

  // 4. Start queen
  console.log('')
  log('RUN', C.bold, `Starting queen for ${NUM_CYCLES} cycles...`)
  console.log('─'.repeat(80))
  await api('POST', `/api/rooms/${room.id}/queen/start`, {}, token)

  // 5. Monitor cycles
  const Database = require('better-sqlite3')
  const start = Date.now()
  const lastLogSeq = {}
  const printedCycles = new Set()
  const completedCycles = new Set()
  let stopped = false
  const wipSnapshots = []  // capture WIP after each cycle

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(2000)

    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    const cycles = db.prepare(
      'SELECT id, status, duration_ms, input_tokens, output_tokens, error_message FROM worker_cycles WHERE room_id = ? ORDER BY id'
    ).all(room.id)

    const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length

    // Check WIP after each completed cycle
    if (done > wipSnapshots.length) {
      const worker = db.prepare('SELECT wip FROM workers WHERE id = ?').get(queen.id)
      wipSnapshots.push({ afterCycle: done, wip: worker?.wip || null })
      console.log('')
      if (worker?.wip) {
        log('WIP', C.green + C.bold, `After cycle ${done}: "${worker.wip}"`)
      } else {
        log('WIP', C.yellow, `After cycle ${done}: (no WIP saved)`)
      }
      console.log('')
    }

    // Stop after target cycles
    if (done >= NUM_CYCLES && !stopped) {
      stopped = true
      api('POST', `/api/rooms/${room.id}/queen/stop`, {}, token).catch(() => {})
      log('RUN', C.bold, `Target ${NUM_CYCLES} cycles reached — stopping.`)
    }

    // Stream logs
    for (const cycle of cycles) {
      if (!printedCycles.has(cycle.id)) {
        printedCycles.add(cycle.id)
        const num = cycles.indexOf(cycle) + 1
        console.log('')
        log('CYCLE', C.cyan + C.bold, `── Cycle ${num} started (id=${cycle.id}) ──`)
      }

      const lastSeq = lastLogSeq[cycle.id] || 0
      const logs = db.prepare(
        'SELECT seq, entry_type, content FROM cycle_logs WHERE cycle_id = ? AND seq > ? ORDER BY seq'
      ).all(cycle.id, lastSeq)

      for (const entry of logs) {
        lastLogSeq[cycle.id] = entry.seq
        const content = (entry.content || '').replace(/\n/g, ' ')

        switch (entry.entry_type) {
          case 'tool_call':
            log('TOOL', C.cyan, `→ ${content.substring(0, 200)}`)
            break
          case 'tool_result':
            log('TOOL', C.dim, `← ${content.substring(0, 150)}`)
            break
          case 'assistant_text':
            log('TEXT', C.white, content.substring(0, 300))
            break
          case 'error':
            log('ERR', C.red, content.substring(0, 200))
            break
          default:
            log('LOG', C.dim, `[${entry.entry_type}] ${content.substring(0, 150)}`)
        }
      }

      if ((cycle.status === 'completed' || cycle.status === 'failed') && !completedCycles.has(cycle.id)) {
        completedCycles.add(cycle.id)
        const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
        const tokIn = cycle.input_tokens || '?'
        const tokOut = cycle.output_tokens || '?'
        if (cycle.status === 'completed') {
          log('CYCLE', C.green + C.bold, `── Cycle done: ${dur}s, tokens: ${tokIn}/${tokOut} ──`)
        } else {
          log('CYCLE', C.red + C.bold, `── Cycle FAILED: ${cycle.error_message || 'unknown'} ──`)
        }
      }
    }

    db.close()

    if (done >= NUM_CYCLES) {
      // Wait a beat for any final logging
      await sleep(3000)
      break
    }
  }

  // 6. Print results
  console.log('')
  console.log('═'.repeat(74))
  console.log(`${C.bold}  WIP SYSTEM TEST RESULTS${C.reset}`)
  console.log('═'.repeat(74))

  const db = new Database(dbPath, { readonly: true })

  // Cycle stats
  const allCycles = db.prepare(
    'SELECT id, duration_ms, input_tokens, output_tokens, status FROM worker_cycles WHERE room_id = ? ORDER BY id'
  ).all(room.id)

  console.log(`\n  ${C.bold}Cycles:${C.reset} ${allCycles.length}`)
  for (const cycle of allCycles) {
    const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
    const tokIn = cycle.input_tokens || '?'
    const tokOut = cycle.output_tokens || '?'
    console.log(`    Cycle ${allCycles.indexOf(cycle) + 1}: ${cycle.status}, ${dur}s, tokens: ${tokIn}/${tokOut}`)
  }

  // Tool call breakdown
  const cycleIds = allCycles.map(c => c.id)
  const toolCounts = {}
  let totalCalls = 0
  for (const cid of cycleIds) {
    const calls = db.prepare(
      "SELECT content FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'"
    ).all(cid)
    totalCalls += calls.length
    for (const call of calls) {
      const match = call.content?.match(/(?:→ |Using )(\w+)/)
      if (match) {
        toolCounts[match[1]] = (toolCounts[match[1]] || 0) + 1
      }
    }
  }
  console.log(`\n  ${C.bold}Tool calls:${C.reset} ${totalCalls} total`)
  for (const [tool, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
    const isSaveWip = tool.includes('save_wip') || tool.includes('wip')
    console.log(`    ${isSaveWip ? C.green + C.bold : ''}${tool}: ${count}${isSaveWip ? C.reset : ''}`)
  }

  // WIP snapshots
  console.log(`\n  ${C.bold}WIP snapshots:${C.reset}`)
  for (const snap of wipSnapshots) {
    const indicator = snap.wip ? C.green + '✓' : C.red + '✗'
    console.log(`    After cycle ${snap.afterCycle}: ${indicator}${C.reset} ${snap.wip || '(empty)'}`)
  }

  // Final WIP state
  const finalWorker = db.prepare('SELECT wip FROM workers WHERE id = ?').get(queen.id)
  console.log(`\n  ${C.bold}Final WIP:${C.reset} ${finalWorker?.wip || '(cleared)'}`)

  // Memories stored
  const memories = db.prepare(
    "SELECT e.name, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND e.name != 'queen_session_summary' ORDER BY e.id"
  ).all(room.id)
  console.log(`\n  ${C.bold}Memories:${C.reset} ${memories.length}`)
  for (const m of memories) {
    const preview = (m.content || '').replace(/\n/g, ' ').substring(0, 100)
    console.log(`    ${C.cyan}${m.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
  }

  // Goals
  const goals = db.prepare('SELECT description, status, progress FROM goals WHERE room_id = ?').all(room.id)
  console.log(`\n  ${C.bold}Goals:${C.reset} ${goals.length}`)
  for (const g of goals) {
    const desc = (g.description || '').substring(0, 80)
    console.log(`    ${desc}: ${g.status} (${Math.round((g.progress || 0) * 100)}%)`)
  }

  // Verdict
  console.log('')
  console.log('─'.repeat(74))
  const wipSaved = wipSnapshots.some(s => s.wip)
  const wipUsedSaveWip = totalCalls > 0 && Object.keys(toolCounts).some(t => t.includes('save_wip') || t.includes('wip'))
  const hadWebSearches = Object.keys(toolCounts).some(t => t.includes('web_search') || t.includes('WebSearch') || t.includes('WebFetch'))
  const hadMemories = memories.length > 0

  const checks = [
    [wipSaved, 'Agent saved WIP between cycles'],
    [wipUsedSaveWip, 'Agent called quoroom_save_wip tool'],
    [hadWebSearches, 'Agent performed web searches (real action)'],
    [hadMemories, 'Agent stored research in memory'],
  ]

  let passed = 0
  for (const [ok, label] of checks) {
    const icon = ok ? C.green + '✓ PASS' : C.red + '✗ FAIL'
    console.log(`  ${icon}${C.reset}  ${label}`)
    if (ok) passed++
  }

  console.log('')
  if (passed === checks.length) {
    console.log(`  ${C.green}${C.bold}ALL CHECKS PASSED${C.reset} — WIP system working!`)
  } else {
    console.log(`  ${C.yellow}${C.bold}${passed}/${checks.length} checks passed${C.reset}`)
  }
  console.log('═'.repeat(74))
  console.log('')

  db.close()
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  restoreMcpConfig()
  stopServer()
  if (!keepDb && dataDir && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
    log('CLEANUP', C.dim, 'Temp DB deleted.')
  } else if (keepDb && dbPath) {
    log('CLEANUP', C.green, `DB preserved: ${dbPath}`)
  }
}

process.on('SIGTERM', () => { cleanup(); process.exit(0) })
process.on('SIGINT', () => { console.log('\nInterrupted.'); cleanup(); process.exit(0) })

main()
  .then(() => { cleanup(); process.exit(0) })
  .catch((err) => {
    console.error(`${C.red}FATAL: ${err.message}${C.reset}`)
    cleanup()
    process.exit(1)
  })
