#!/usr/bin/env node
/**
 * Queen Experiment Runner — live interactive mode
 *
 * Run directly — everything is self-contained:
 *
 *   node scripts/experiment.js                    # 3 cycles, all models (solo mode)
 *   node scripts/experiment.js --cycles 2 --models api   # 2 cycles, API only
 *   node scripts/experiment.js --swarm             # swarm: 1 room, 4 agents
 *   node scripts/experiment.js --swarm --cycles 2  # quick swarm test
 *   node scripts/experiment.js --help
 *
 * Modes:
 *   Solo (default): Each model gets its own room, 1 queen per room
 *   Swarm (--swarm): 1 room with 4 agents (queen + 3 workers) collaborating
 *
 * What it does:
 *   1. Loads API keys from cloud/.env automatically
 *   2. Builds the server (esbuild)
 *   3. Starts an isolated server on port 3710 (temp DB, separate from dev)
 *   4. Creates room(s), sets goals, starts queens/workers
 *   5. Streams ALL activity live to terminal (tool calls, messages, votes, memories)
 *   6. Prints comparison table + memory dump when done
 *   7. Cleans up (Ctrl+C safe)
 *
 * Options:
 *   --cycles N      Number of cycles per agent (default: 3, swarm default: 5)
 *   --models FILTER  "api" | "cli" | comma-separated labels (solo mode only)
 *   --swarm         Swarm mode: 1 room, 4 agents collaborating
 *   --goal "..."    Custom goal for all rooms
 *   --keep-db       Don't delete temp DB after experiment
 *   --help          Show this help
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

const DEFAULT_GOAL = 'Build a plan to launch an AI consulting service. Research market rates online. Store findings in memory. Create sub-goals for pricing and outreach. Message the keeper with your strategy and budget needs. Report progress every cycle.'

// Minimal tool set for solo experiments — removes tools that waste turns
const EXPERIMENT_TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch',
].join(',')

// Swarm tool set — adds governance, subgoals, delegation, and messaging for multi-agent coordination
const SWARM_TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal', 'quoroom_create_subgoal',
  'quoroom_delegate_task',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_propose', 'quoroom_vote',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch',
].join(',')

const SWARM_MAX_TURNS = 50
const SWARM_CYCLE_GAP_MS = 5000

const DEFAULT_SWARM_GOAL = `You are part of a multi-agent swarm. Your team must collaboratively build a comprehensive plan to launch an AI consulting service.

Coordination rules:
- The Queen should use quoroom_delegate_task to assign specific tasks to workers by name
- Workers: check "Your Assigned Tasks" in your context and prioritize completing them
- Use quoroom_send_message to communicate with teammates (use their names from Room Workers)
- Use quoroom_propose for major decisions that need team agreement, then vote
- Use quoroom_remember to store findings so all agents can access them
- Divide work: one agent researches market rates, another develops pricing, another creates outreach plan
- Check messages from other workers each cycle and respond
- Update goal progress as you make discoveries

Deliver: market research, pricing strategy, outreach plan, and a synthesized executive summary.`

const SWARM_MODELS = [
  { label: 'claude', model: 'claude', type: 'cli', isQueen: true },
  { label: 'oai-mini', model: 'openai:gpt-4o-mini', type: 'api', keyEnv: 'OPENAI_API_KEY', credName: 'openai_api_key', isQueen: false },
  { label: 'anth-api', model: 'anthropic:claude-sonnet-4-6', type: 'api', keyEnv: 'ANTHROPIC_API_KEY', credName: 'anthropic_api_key', isQueen: false },
  { label: 'oai-api', model: 'openai:gpt-4o', type: 'api', keyEnv: 'OPENAI_API_KEY', credName: 'openai_api_key', isQueen: false },
]

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

if (args.includes('--help') || args.includes('-h')) {
  // Print the JSDoc header as help text
  const src = readFileSync(__filename, 'utf-8')
  const match = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (match) console.log(match[1].replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}

function getArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : null
}
const isSwarm = args.includes('--swarm')
const numCycles = parseInt(getArg('--cycles') || (isSwarm ? '5' : '3'), 10)
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

  // Update installed MCP binary so Claude CLI picks up code changes
  // (Claude CLI reads MCP from /usr/local/lib/quoroom/lib/server.js via ~/.claude.json)
  const installedMcp = '/usr/local/lib/quoroom/lib/server.js'
  try {
    execSync(`cp out/mcp/server.js ${installedMcp}`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
    log('BUILD', C.blue, 'Updated installed MCP server.')
  } catch {
    log('BUILD', C.yellow, `Could not update ${installedMcp} — run with sudo or copy manually.`)
  }

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
      queenMaxTurns: MAX_TURNS,
      allowedTools: EXPERIMENT_TOOLS
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
  const stoppedRooms = new Set()  // rooms that reached target cycle count

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

      // Stop queen once it reaches target cycle count (prevents fast models from over-cycling)
      if (done >= numCycles && !stoppedRooms.has(r.roomId)) {
        stoppedRooms.add(r.roomId)
        api('POST', `/api/rooms/${r.roomId}/queen/stop`, {}, token).catch(() => {})
        log(r.label, r.color, `${C.bold}── Target ${numCycles} cycle(s) reached — queen stopped ──${C.reset}`)
      }

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

    // Outcome quality metrics
    const productiveRx = /web_search|web_fetch|remember|send_message|inbox_send|update_progress|complete_goal|set_goal|delegate_task|propose|vote/
    let productiveCalls = 0
    let stuckCycles = 0
    const uniqueSearches = new Set()
    for (const cid of cycleIds) {
      const calls = db.prepare(
        "SELECT content FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'"
      ).all(cid)
      let cycleProductive = 0
      for (const call of calls) {
        if (productiveRx.test(call.content)) cycleProductive++
        const searchMatch = call.content?.match(/web_search.*?"([^"]+)"/)
        if (searchMatch) uniqueSearches.add(searchMatch[1].toLowerCase().trim())
      }
      if (cycleProductive === 0 && calls.length > 0) stuckCycles++
      productiveCalls += cycleProductive
    }
    const productivePct = toolCalls > 0 ? Math.round((productiveCalls / toolCalls) * 100) : 0
    const memoryChars = db.prepare(
      'SELECT COALESCE(SUM(LENGTH(o.content)), 0) as total FROM observations o JOIN entities e ON o.entity_id = e.id WHERE e.room_id = ?'
    ).get(r.roomId)

    results.push({
      label: r.label,
      totalDuration: (totalDuration / 1000).toFixed(1) + 's',
      avgDuration: (avgDuration / 1000).toFixed(1) + 's',
      tokens: `${fmtK(totalInputTokens)}/${fmtK(totalOutputTokens)}`,
      toolCalls,
      productivePct: productivePct + '%',
      uniqueSearches: uniqueSearches.size,
      keeperMsgs: keeperMsgs.cnt,
      goals: `${goalsCreated}/${goalsCompleted}`,
      memories: memories.cnt,
      memoryDepth: fmtK(memoryChars.total),
      stuckCycles,
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
    ['Avg cycle', r => r.avgDuration],
    ['Tokens (in/out)', r => r.tokens],
    ['Tool calls', r => String(r.toolCalls)],
    ['Productive %', r => r.productivePct],
    ['Unique searches', r => String(r.uniqueSearches)],
    ['Keeper messages', r => String(r.keeperMsgs)],
    ['Goals (made/done)', r => r.goals],
    ['Memories stored', r => String(r.memories)],
    ['Memory depth', r => r.memoryDepth],
    ['Stuck cycles', r => String(r.stuckCycles)],
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

function printMemoryDump(rooms) {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  console.log('='.repeat(74))
  console.log('  MEMORY DUMP — What each queen stored')
  console.log('='.repeat(74))
  for (const r of rooms) {
    const entities = db.prepare(
      "SELECT e.name, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND e.name != 'queen_session_summary' ORDER BY e.id"
    ).all(r.roomId)
    console.log(`\n  ${C.bold}${r.label}${C.reset} (${entities.length} memories):`)
    for (const e of entities) {
      const preview = (e.content || '').replace(/\n/g, ' ').substring(0, 120)
      console.log(`    ${C.cyan}${e.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
    }
  }
  console.log('')
  db.close()
}

function pad(s, w) {
  if (s.length >= w) return s.substring(0, w - 1) + ' '
  return s + ' '.repeat(w - s.length)
}

// ─── Swarm mode ─────────────────────────────────────────────────────────────

async function setupSwarm(token, apiKeys) {
  const swarmGoal = goal !== DEFAULT_GOAL ? goal : DEFAULT_SWARM_GOAL

  log('SWARM', C.bold, 'Creating swarm room...')

  // 1. Create room (auto-creates queen)
  const queenModel = SWARM_MODELS.find(m => m.isQueen)
  const res = await api('POST', '/api/rooms', { name: 'swarm-experiment', goal: swarmGoal }, token)
  if (res.status !== 200 && res.status !== 201) {
    log('SWARM', C.red, `FAILED to create room: ${JSON.stringify(res.data).substring(0, 200)}`)
    return null
  }
  const room = res.data.room || res.data
  const queen = res.data.queen

  log('SWARM', C.cyan, `Room #${room.id} created, queen #${queen.id}`)

  // 2. Configure queen
  await api('PATCH', `/api/workers/${queen.id}`, { model: queenModel.model, name: 'Queen (claude)' }, token)

  // 3. Set room config
  await api('PATCH', `/api/rooms/${room.id}`, {
    workerModel: queenModel.model,
    queenCycleGapMs: SWARM_CYCLE_GAP_MS,
    queenMaxTurns: SWARM_MAX_TURNS,
    allowedTools: SWARM_TOOLS
  }, token)

  // 4. Set API credentials
  for (const m of SWARM_MODELS) {
    if (m.type === 'api' && m.credName && apiKeys[m.keyEnv]) {
      await api('POST', `/api/rooms/${room.id}/credentials`, {
        name: m.credName, type: 'api_key', value: apiKeys[m.keyEnv]
      }, token)
      log('SWARM', C.green, `API key ${m.credName} configured`)
    }
  }

  // 5. Build agent list starting with queen
  const agents = [{
    ...queenModel,
    workerId: queen.id,
    roomId: room.id,
    color: ROOM_COLORS[0]
  }]

  // 6. Create worker agents
  const workerModels = SWARM_MODELS.filter(m => !m.isQueen)
  for (let i = 0; i < workerModels.length; i++) {
    const m = workerModels[i]
    const color = ROOM_COLORS[(i + 1) % ROOM_COLORS.length]
    const workerRes = await api('POST', '/api/workers', {
      name: `Worker (${m.label})`,
      systemPrompt: `You are a worker agent in a multi-agent swarm. Your model is ${m.model}. Collaborate with other agents using quoroom_send_message (specify the worker name in "to"). Vote on proposals with quoroom_vote. Store findings in memory with quoroom_remember so all agents can access them. Focus on making measurable progress each cycle.`,
      roomId: room.id,
      maxTurns: SWARM_MAX_TURNS,
      cycleGapMs: SWARM_CYCLE_GAP_MS
    }, token)

    if (workerRes.status !== 201) {
      log(m.label, C.red, `Failed to create worker: ${JSON.stringify(workerRes.data).substring(0, 200)}`)
      continue
    }

    const worker = workerRes.data
    await api('PATCH', `/api/workers/${worker.id}`, { model: m.model }, token)

    agents.push({ ...m, workerId: worker.id, roomId: room.id, color })
    log(m.label, color, `Worker #${worker.id} created (model: ${m.model})`)
  }

  return { roomId: room.id, queenId: queen.id, agents }
}

async function runSwarmCycles(token, swarm) {
  const Database = require('better-sqlite3')
  const { roomId, agents } = swarm

  console.log('')
  log('SWARM', C.bold, `Starting ${agents.length} agents for ${numCycles} cycle(s) each...`)
  console.log('')

  // Start queen
  const queenAgent = agents.find(a => a.isQueen)
  await api('POST', `/api/rooms/${roomId}/queen/start`, {}, token)
  log(queenAgent.label, queenAgent.color, 'Queen started')

  // Start non-queen workers
  for (const a of agents.filter(a => !a.isQueen)) {
    const res = await api('POST', `/api/workers/${a.workerId}/start`, {}, token)
    log(a.label, a.color, res.status === 200 ? 'Worker started' : `Start failed: ${JSON.stringify(res.data)}`)
  }

  console.log('')
  log('SWARM', C.bold, 'Monitoring all agents live...')
  console.log('─'.repeat(80))

  const start = Date.now()
  const lastLogSeq = {}
  const printedCycles = new Set()
  const completedCycles = new Set()
  const stoppedAgents = new Set()

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(2000)

    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    let allDone = true

    for (const agent of agents) {
      const cycles = db.prepare(
        'SELECT id, status, duration_ms, input_tokens, output_tokens, error_message FROM worker_cycles WHERE worker_id = ? AND room_id = ? ORDER BY id'
      ).all(agent.workerId, roomId)

      const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length
      if (done < numCycles) allDone = false

      // Stop agent once it reaches target cycle count
      if (done >= numCycles && !stoppedAgents.has(agent.workerId)) {
        stoppedAgents.add(agent.workerId)
        if (agent.isQueen) {
          api('POST', `/api/rooms/${roomId}/queen/stop`, {}, token).catch(() => {})
        } else {
          api('POST', `/api/workers/${agent.workerId}/stop`, {}, token).catch(() => {})
        }
        log(agent.label, agent.color, `${C.bold}── Target ${numCycles} cycle(s) reached — agent stopped ──${C.reset}`)
      }

      // Stream logs for each cycle
      for (const cycle of cycles) {
        if (!printedCycles.has(cycle.id)) {
          printedCycles.add(cycle.id)
          const cycleNum = cycles.indexOf(cycle) + 1
          console.log('')
          log(agent.label, agent.color, `${C.bold}── Cycle ${cycleNum} started (cycle_id=${cycle.id}) ──${C.reset}`)
        }

        const lastSeq = lastLogSeq[cycle.id] || 0
        const logs = db.prepare(
          'SELECT seq, entry_type, content FROM cycle_logs WHERE cycle_id = ? AND seq > ? ORDER BY seq'
        ).all(cycle.id, lastSeq)

        for (const entry of logs) {
          lastLogSeq[cycle.id] = entry.seq
          const content = (entry.content || '').replace(/\n/g, '\n' + ' '.repeat(28))

          switch (entry.entry_type) {
            case 'tool_call':
              log(agent.label, agent.color, `  -> ${C.cyan}${content.substring(0, 200)}${C.reset}`)
              break
            case 'tool_result':
              log(agent.label, agent.color, `  <- ${C.dim}${content.substring(0, 300)}${C.reset}`)
              break
            case 'assistant_text':
              log(agent.label, agent.color, `  ${C.white}${content.substring(0, 400)}${C.reset}`)
              break
            case 'error':
              log(agent.label, C.red, `  ERROR: ${content.substring(0, 300)}`)
              break
            default:
              log(agent.label, agent.color, `  [${entry.entry_type}] ${content.substring(0, 200)}`)
          }
        }

        if ((cycle.status === 'completed' || cycle.status === 'failed') && !completedCycles.has(cycle.id)) {
          completedCycles.add(cycle.id)
          const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
          const tokIn = cycle.input_tokens || '?'
          const tokOut = cycle.output_tokens || '?'
          if (cycle.status === 'completed') {
            log(agent.label, agent.color, `${C.bold}── Cycle done: ${dur}s, tokens: ${tokIn}/${tokOut} ──${C.reset}`)
          } else {
            log(agent.label, C.red, `${C.bold}── Cycle FAILED: ${cycle.error_message || 'unknown'} ──${C.reset}`)
          }
        }
      }
    }

    db.close()

    if (allDone) {
      console.log('')
      log('SWARM', C.green + C.bold, 'All agents completed!')
      return
    }
  }

  console.log('')
  log('SWARM', C.red, 'TIMEOUT — some agents did not complete')
}

function collectSwarmResults(swarm) {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const { roomId, agents } = swarm

  // Per-agent metrics
  const agentResults = []
  for (const agent of agents) {
    const cycles = db.prepare(
      'SELECT id, duration_ms, input_tokens, output_tokens, status FROM worker_cycles WHERE worker_id = ? AND room_id = ? ORDER BY id'
    ).all(agent.workerId, roomId)

    const completed = cycles.filter(c => c.status === 'completed')
    const totalDuration = completed.reduce((s, c) => s + (c.duration_ms || 0), 0)
    const totalInputTokens = completed.reduce((s, c) => s + (c.input_tokens || 0), 0)
    const totalOutputTokens = completed.reduce((s, c) => s + (c.output_tokens || 0), 0)

    let toolCalls = 0
    const uniqueTools = new Set()
    for (const c of completed) {
      const calls = db.prepare("SELECT content FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'").all(c.id)
      toolCalls += calls.length
      for (const call of calls) {
        const match = call.content?.match(/(?:→ |Using )(\w+)/)
        if (match) uniqueTools.add(match[1])
      }
    }

    // Messages sent by this agent
    const msgsSent = db.prepare(
      'SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND from_agent_id = ?'
    ).get(roomId, agent.workerId)

    agentResults.push({
      label: agent.label,
      cycles: completed.length,
      totalDuration: (totalDuration / 1000).toFixed(1) + 's',
      tokens: `${fmtK(totalInputTokens)}/${fmtK(totalOutputTokens)}`,
      toolCalls,
      uniqueTools: uniqueTools.size,
      msgsSent: msgsSent.cnt,
      errors: cycles.filter(c => c.status === 'failed').length
    })
  }

  // Collaboration metrics (room-wide)
  const interWorkerMsgs = db.prepare(
    'SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NOT NULL'
  ).get(roomId)

  const keeperMsgs = db.prepare(
    'SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NULL'
  ).get(roomId)

  const votes = db.prepare(
    'SELECT COUNT(*) as cnt FROM quorum_votes WHERE decision_id IN (SELECT id FROM quorum_decisions WHERE room_id = ?)'
  ).get(roomId)

  const decisions = db.prepare(
    'SELECT COUNT(*) as cnt FROM quorum_decisions WHERE room_id = ?'
  ).get(roomId)

  const memories = db.prepare(
    'SELECT COUNT(*) as cnt FROM entities WHERE room_id = ?'
  ).get(roomId)

  const goals = db.prepare(
    'SELECT id, status, progress FROM goals WHERE room_id = ?'
  ).all(roomId)

  db.close()

  return {
    agentResults,
    collaboration: {
      interWorkerMsgs: interWorkerMsgs.cnt,
      keeperMsgs: keeperMsgs.cnt,
      votesCast: votes.cnt,
      proposalsMade: decisions.cnt,
      memoriesStored: memories.cnt,
      goalsCreated: goals.length,
      goalsCompleted: goals.filter(g => g.status === 'completed').length,
      maxProgress: goals.length > 0 ? Math.max(...goals.map(g => g.progress ?? 0)) : 0
    }
  }
}

function printSwarmResults(results) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const swarmGoal = goal !== DEFAULT_GOAL ? goal : DEFAULT_SWARM_GOAL
  console.log('\n' + '='.repeat(74))
  console.log(`  SWARM EXPERIMENT RESULTS - ${now}`)
  console.log(`  Agents: ${results.agentResults.length} | Cycles: ${numCycles} per agent`)
  console.log('='.repeat(74))

  // Per-agent table
  const labelW = 18
  const colW = 14
  const labels = results.agentResults.map(r => r.label)

  console.log('')
  console.log('  ' + pad('Agent', labelW) + labels.map(l => pad(l, colW)).join(''))
  console.log('  ' + '-'.repeat(labelW) + labels.map(() => '-'.repeat(colW)).join(''))

  const metrics = [
    ['Cycles done', r => String(r.cycles)],
    ['Duration', r => r.totalDuration],
    ['Tokens (in/out)', r => r.tokens],
    ['Tool calls', r => String(r.toolCalls)],
    ['Unique tools', r => String(r.uniqueTools)],
    ['Messages sent', r => String(r.msgsSent)],
    ['Errors', r => String(r.errors)],
  ]
  for (const [name, fn] of metrics) {
    console.log('  ' + pad(name, labelW) + results.agentResults.map(fn).map(v => pad(v, colW)).join(''))
  }

  // Collaboration summary
  const c = results.collaboration
  console.log('')
  console.log('  COLLABORATION METRICS')
  console.log('  ' + '-'.repeat(40))
  console.log(`  Inter-agent messages:  ${c.interWorkerMsgs}`)
  console.log(`  Keeper messages:       ${c.keeperMsgs}`)
  console.log(`  Proposals made:        ${c.proposalsMade}`)
  console.log(`  Votes cast:            ${c.votesCast}`)
  console.log(`  Shared memories:       ${c.memoriesStored}`)
  console.log(`  Goals (made/done):     ${c.goalsCreated}/${c.goalsCompleted}`)
  console.log(`  Max goal progress:     ${Math.round(c.maxProgress * 100)}%`)
  console.log('')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const activeGoal = isSwarm && goal === DEFAULT_GOAL ? DEFAULT_SWARM_GOAL : goal
  const modelsForKeys = isSwarm ? SWARM_MODELS : MODELS

  console.log('')
  if (isSwarm) {
    console.log(`${C.bold}Swarm Experiment${C.reset} — ${numCycles} cycles, 4 agents in 1 room`)
  } else {
    console.log(`${C.bold}Queen Experiment${C.reset} — ${numCycles} cycles, ${MODELS.length} models`)
  }
  console.log(`Goal: "${activeGoal.substring(0, 100)}${activeGoal.length > 100 ? '...' : ''}"`)
  console.log('')

  // 1. Load API keys
  const cloudEnv = loadCloudEnv()
  const apiKeys = {}
  for (const m of modelsForKeys) {
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

  if (isSwarm) {
    // === SWARM MODE ===
    console.log('')
    log('SETUP', C.bold, 'Setting up swarm...')
    const swarm = await setupSwarm(token, apiKeys)
    if (!swarm) {
      log('SETUP', C.red, 'Swarm setup failed! Aborting.')
      stopServer()
      process.exit(1)
    }

    await runSwarmCycles(token, swarm)

    const results = collectSwarmResults(swarm)
    printSwarmResults(results)
    printMemoryDump([{ label: 'swarm', roomId: swarm.roomId, queenId: swarm.queenId, color: C.cyan }])
  } else {
    // === SOLO MODE ===
    console.log('')
    log('SETUP', C.bold, 'Creating experiment rooms...')
    const rooms = await setupRooms(token, apiKeys)
    if (rooms.length === 0) {
      log('SETUP', C.red, 'No rooms created! Aborting.')
      stopServer()
      process.exit(1)
    }

    await runCycles(token, rooms)

    const results = collectResults(rooms)
    printResults(results)
    printMemoryDump(rooms)
  }

  // Cleanup
  stopServer()
  if (keepDb) {
    log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
  } else {
    try { rmSync(dataDir, { recursive: true }) } catch {}
    log('CLEANUP', C.dim, 'Temp DB cleaned up.')
  }
}

// Clean shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log(`\n${C.yellow}Interrupted — cleaning up...${C.reset}`)
  stopServer()
  if (!keepDb && dataDir) {
    try { rmSync(dataDir, { recursive: true }) } catch {}
  }
  process.exit(0)
})
process.on('SIGTERM', () => {
  stopServer()
  process.exit(0)
})

main().catch(err => {
  console.error(`\n${C.red}Experiment failed: ${err.message}${C.reset}`)
  if (err.stack) console.error(C.dim + err.stack + C.reset)
  stopServer()
  process.exit(1)
})
