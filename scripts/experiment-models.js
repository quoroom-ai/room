#!/usr/bin/env node
/**
 * Model Comparison Experiment — Same task, different models, head-to-head
 *
 * Each model gets its own room with the same goal. They work independently.
 * Compares: browser actions, skills created, memories, task completion.
 *
 *   node scripts/experiment-models.js                  # 2 cycles, 3 models
 *   node scripts/experiment-models.js --cycles 3       # 3 cycles
 *   node scripts/experiment-models.js --keep-db
 *   node scripts/experiment-models.js --help
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const http = require('http')

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = 3710
const TIMEOUT_MS = 60 * 60 * 1000  // 60 min
const MAX_TURNS = 50
const CYCLE_GAP_MS = 12000

const MODELS = [
  { label: 'claude-cli', model: 'claude', type: 'cli' },
  { label: 'sonnet-api', model: 'anthropic:claude-sonnet-4-6', type: 'api', keyEnv: 'ANTHROPIC_API_KEY', credName: 'anthropic_api_key' },
  { label: 'gpt4o-api', model: 'openai:gpt-4o', type: 'api', keyEnv: 'OPENAI_API_KEY', credName: 'openai_api_key' },
]

const TASK = `You are a solo execution agent. Your mission is to ACTUALLY DO things on the internet using the quoroom_browser tool.

Context: Quoroom is an AI agent platform (github.com/quoroom-ai/room, quoroom.ai).

TASKS — complete as many as possible:
1. CREATE A FREE EMAIL ACCOUNT
   - Navigate to Tuta (app.tuta.com) using quoroom_browser
   - Select Free plan, fill signup form, handle CAPTCHA if any
   - Store credentials in quoroom_remember IMMEDIATELY
   - Verify you can log in

2. FIND 5+ AI STARTUP CONTACTS
   - Use quoroom_web_search to find AI agent companies
   - Use quoroom_browser to visit their websites
   - Extract real email addresses from about/team/contact pages
   - Store each contact in quoroom_remember

3. SEND AN OUTREACH EMAIL (if email account created)
   - Log into your email using quoroom_browser with stored sessionId
   - Compose and send email about Quoroom to one contact

RULES:
- USE quoroom_browser for ALL web interactions — it has persistent sessions
- Pass sessionId between calls to keep login state
- Take snapshots frequently to see page state
- If CAPTCHA appears: use screenshot action, then Read tool to view the image
- Store ALL credentials and results in quoroom_remember immediately
- Check quoroom_list_skills and quoroom_recall FIRST — reuse existing knowledge

MANDATORY — Execution Report:
Before each cycle ends, you MUST call quoroom_create_skill with a detailed report:
- Title: "[task] — [site/service]" (e.g. "Tuta signup algorithm")
- Body: step-by-step what you tried, what FAILED (exact errors), what WORKED (exact selectors)
- Set autoActivate: true, activationContext: relevant keywords
- Even if you failed, write the report so future cycles learn from your mistakes`

const TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch', 'quoroom_browser',
  'quoroom_create_skill', 'quoroom_list_skills', 'quoroom_edit_skill', 'quoroom_activate_skill',
].join(',')

// ─── Colors ──────────────────────────────────────────────────────────────────

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
  const src = readFileSync(__filename, 'utf-8')
  const match = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (match) console.log(match[1].replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}

function getArg(name) {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : null
}

const numCycles = parseInt(getArg('--cycles') || '2', 10)

// ─── Cloud env (API keys) ───────────────────────────────────────────────────

function loadCloudEnv() {
  const envPath = '/Users/vasily/projects/cloud/.env'
  if (!existsSync(envPath)) {
    log('KEYS', C.red, 'cloud/.env not found — API models will fail')
    return {}
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

function overrideMcpDbPath(experimentDbPath) {
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8'))
    const quoroom = config.mcpServers?.quoroom
    if (!quoroom) return
    originalMcpDbPath = quoroom.env?.QUOROOM_DB_PATH ?? null
    if (!quoroom.env) quoroom.env = {}
    quoroom.env.QUOROOM_DB_PATH = experimentDbPath
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    log('MCP', C.green, `DB override → ${experimentDbPath}`)
  } catch (e) {
    log('MCP', C.yellow, `Could not override MCP DB: ${e.message}`)
  }
}

function restoreMcpDbPath() {
  if (originalMcpDbPath === null) return
  try {
    const config = JSON.parse(readFileSync(CLAUDE_CONFIG_PATH, 'utf-8'))
    const quoroom = config.mcpServers?.quoroom
    if (!quoroom?.env) return
    quoroom.env.QUOROOM_DB_PATH = originalMcpDbPath
    writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
    log('MCP', C.dim, 'DB restored to original path.')
  } catch (e) {
    log('MCP', C.yellow, `Could not restore MCP DB: ${e.message}`)
  }
  originalMcpDbPath = null
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

let serverProcess = null
let dataDir = null
let dbPath = null

function startServer(extraEnv = {}) {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-models-${ts}`
  dbPath = path.join(dataDir, 'data.db')
  mkdirSync(dataDir, { recursive: true })

  log('SERVER', C.green, `Starting on :${PORT}`)
  log('SERVER', C.green, `DB: ${dbPath}`)

  serverProcess = spawn('node', [path.join(PROJECT_ROOT, 'out/mcp/cli.js'), 'serve', '--port', String(PORT)], {
    env: {
      ...process.env,
      ...extraEnv,
      QUOROOM_DB_PATH: dbPath,
      QUOROOM_DATA_DIR: dataDir,
      QUOROOM_SKIP_MCP_REGISTER: '1',
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  serverProcess.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) log('SERVER', C.dim, line)
  })
  serverProcess.stderr.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) log('SERVER', C.dim, line)
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
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null }
}

// ─── Setup — one room per model ─────────────────────────────────────────────

async function setup(token, apiKeys) {
  log('SETUP', C.bold, `Creating ${MODELS.length} rooms (one per model)...`)

  const rooms = []

  for (let i = 0; i < MODELS.length; i++) {
    const m = MODELS[i]
    const color = ROOM_COLORS[i % ROOM_COLORS.length]

    // Create room (auto-creates queen)
    const res = await api('POST', '/api/rooms', { name: `model-${m.label}`, goal: TASK }, token)
    if (res.status !== 200 && res.status !== 201) {
      log(m.label, C.red, `FAILED: ${JSON.stringify(res.data).substring(0, 200)}`)
      continue
    }
    const room = res.data.room || res.data
    const queen = res.data.queen

    // Set model on queen
    await api('PATCH', `/api/workers/${queen.id}`, { model: m.model, name: m.label }, token)

    // Room config
    await api('PATCH', `/api/rooms/${room.id}`, {
      workerModel: m.model,
      queenCycleGapMs: CYCLE_GAP_MS,
      queenMaxTurns: MAX_TURNS,
      allowedTools: TOOLS,
      config: { autoApprove: [], minVoters: 1 }
    }, token)

    // Store API credentials for API models
    if (m.type === 'api' && m.credName && apiKeys[m.keyEnv]) {
      await api('POST', `/api/rooms/${room.id}/credentials`, {
        name: m.credName, type: 'api_key', value: apiKeys[m.keyEnv]
      }, token)
      log(m.label, color, `API key ${m.credName} configured`)
    }

    rooms.push({
      label: m.label, model: m.model, type: m.type,
      roomId: room.id, queenId: queen.id, color
    })
    log(m.label, color, `Room #${room.id}, queen #${queen.id} (${m.model})`)
  }

  return rooms
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

async function runCycles(token, rooms) {
  const Database = require('better-sqlite3')

  console.log('')
  log('RUN', C.bold, `Starting ${rooms.length} models for ${numCycles} cycle(s) each...`)
  console.log('')

  // Start all queens
  for (const r of rooms) {
    await api('POST', `/api/rooms/${r.roomId}/queen/start`, {}, token)
    log(r.label, r.color, `Started (${r.model})`)
    await sleep(2000)
  }

  console.log('')
  log('RUN', C.bold, 'Monitoring all models live...')
  console.log('─'.repeat(80))

  const start = Date.now()
  const lastLogSeq = {}
  const printedCycles = new Set()
  const completedCycles = new Set()
  const stoppedRooms = new Set()

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(3000)

    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    let allDone = true

    for (const r of rooms) {
      const cycles = db.prepare(
        'SELECT id, status, duration_ms, error_message FROM worker_cycles WHERE worker_id = ? AND room_id = ? ORDER BY id'
      ).all(r.queenId, r.roomId)

      const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length
      if (done < numCycles) allDone = false

      if (done >= numCycles && !stoppedRooms.has(r.roomId)) {
        stoppedRooms.add(r.roomId)
        api('POST', `/api/rooms/${r.roomId}/queen/stop`, {}, token).catch(() => {})
        log(r.label, r.color, `${C.bold}── Target ${numCycles} cycle(s) reached — stopped ──${C.reset}`)
      }

      for (const cycle of cycles) {
        if (!printedCycles.has(cycle.id)) {
          printedCycles.add(cycle.id)
          const cycleNum = cycles.indexOf(cycle) + 1
          console.log('')
          log(r.label, r.color, `${C.bold}── Cycle ${cycleNum} (id=${cycle.id}) ──${C.reset}`)
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
              log(r.label, r.color, `  -> ${C.cyan}${content.substring(0, 200)}${C.reset}`)
              break
            case 'tool_result':
              break  // skip verbose tool results
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

        if ((cycle.status === 'completed' || cycle.status === 'failed') && !completedCycles.has(cycle.id)) {
          completedCycles.add(cycle.id)
          const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
          if (cycle.status === 'completed') {
            log(r.label, r.color, `${C.bold}── Done: ${dur}s ──${C.reset}`)
          } else {
            log(r.label, C.red, `${C.bold}── FAILED: ${(cycle.error_message || 'unknown').substring(0, 200)} ──${C.reset}`)
          }
        }
      }
    }

    db.close()
    if (allDone) {
      console.log('')
      log('RUN', C.green + C.bold, 'All models completed!')
      return
    }
  }

  console.log('')
  log('RUN', C.red, 'TIMEOUT — some models did not complete')
}

// ─── Results ─────────────────────────────────────────────────────────────────

function pad(s, w) {
  if (s.length >= w) return s.substring(0, w - 1) + ' '
  return s + ' '.repeat(w - s.length)
}

function printResults(rooms) {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  console.log('\n' + '='.repeat(90))
  console.log(`  MODEL COMPARISON RESULTS - ${now}`)
  console.log(`  Models: ${rooms.map(r => r.label).join(' vs ')} | Cycles: ${numCycles}`)
  console.log('='.repeat(90))

  // Header
  console.log('')
  console.log('  ' + pad('Metric', 28) + rooms.map(r => pad(r.label, 18)).join(''))
  console.log('  ' + '-'.repeat(28 + rooms.length * 18))

  // Collect metrics per room
  const metrics = rooms.map(r => {
    const cycles = db.prepare(
      'SELECT id, status, duration_ms FROM worker_cycles WHERE worker_id = ? AND room_id = ?'
    ).all(r.queenId, r.roomId)
    const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length

    let toolCalls = 0, browserCalls = 0, totalDur = 0
    for (const c of cycles) {
      toolCalls += db.prepare("SELECT COUNT(*) as cnt FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'").get(c.id).cnt
      browserCalls += db.prepare("SELECT COUNT(*) as cnt FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call' AND content LIKE '%browser%'").get(c.id).cnt
      totalDur += c.duration_ms || 0
    }

    const memories = db.prepare("SELECT COUNT(*) as cnt FROM entities WHERE room_id = ? AND name != 'queen_session_summary'").get(r.roomId).cnt
    const skills = db.prepare("SELECT COUNT(*) as cnt FROM skills WHERE room_id = ?").get(r.roomId).cnt
    const goals = db.prepare('SELECT COUNT(*) as cnt FROM goals WHERE room_id = ?').get(r.roomId).cnt
    const goalsDone = db.prepare("SELECT COUNT(*) as cnt FROM goals WHERE room_id = ? AND status = 'completed'").get(r.roomId).cnt

    // Check for email account (look for credential-like memories)
    const emailMems = db.prepare("SELECT COUNT(*) as cnt FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND (o.content LIKE '%@tuta%' OR o.content LIKE '%@proton%' OR o.content LIKE '%password%' OR e.name LIKE '%email%' OR e.name LIKE '%credential%' OR e.name LIKE '%account%')").get(r.roomId).cnt
    const contactMems = db.prepare("SELECT COUNT(*) as cnt FROM entities e WHERE e.room_id = ? AND (e.name LIKE '%contact%' OR e.name LIKE '%lead%')").get(r.roomId).cnt

    return {
      cycles: done, toolCalls, browserCalls, totalDur,
      memories, skills, goals, goalsDone,
      emailCreated: emailMems > 0 ? 'YES' : 'no',
      contactsFound: contactMems,
    }
  })

  // Print rows
  const rows = [
    ['Cycles completed', m => String(m.cycles)],
    ['Total time (s)', m => (m.totalDur / 1000).toFixed(0)],
    ['Tool calls', m => String(m.toolCalls)],
    ['Browser actions', m => String(m.browserCalls)],
    ['Memories created', m => String(m.memories)],
    ['Skills (reports)', m => String(m.skills)],
    ['Goals (made/done)', m => `${m.goals}/${m.goalsDone}`],
    ['Email account', m => m.emailCreated],
    ['Contact memories', m => String(m.contactsFound)],
  ]

  for (const [label, fn] of rows) {
    console.log('  ' + pad(label, 28) + metrics.map(m => pad(fn(m), 18)).join(''))
  }

  // Memory dump per room
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]
    const entities = db.prepare(
      "SELECT e.name, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND e.name != 'queen_session_summary' ORDER BY e.id"
    ).all(r.roomId)

    const skills = db.prepare('SELECT name, body FROM skills WHERE room_id = ? ORDER BY id').all(r.roomId)

    console.log('')
    console.log('─'.repeat(90))
    console.log(`  ${r.color}${C.bold}${r.label}${C.reset} (${r.model}) — ${entities.length} memories, ${skills.length} skills`)
    console.log('─'.repeat(90))

    if (skills.length > 0) {
      console.log(`  ${C.bold}Skills:${C.reset}`)
      for (const s of skills) {
        const preview = (s.body || '').replace(/\n/g, ' ').substring(0, 150)
        console.log(`    ${C.green}${s.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
      }
    }

    if (entities.length > 0) {
      console.log(`  ${C.bold}Memories:${C.reset}`)
      for (const e of entities) {
        const preview = (e.content || '').replace(/\n/g, ' ').substring(0, 120)
        console.log(`    ${C.cyan}${e.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
      }
    }
  }

  db.close()
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}Model Comparison Experiment${C.reset} — ${numCycles} cycles, ${MODELS.length} models`)
  console.log(`Models: ${MODELS.map(m => m.label + ' (' + m.model + ')').join(', ')}`)
  console.log(`Task: Same for all — create email, find contacts, write execution reports\n`)

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

  // 3. Start server with API keys
  startServer({
    ANTHROPIC_API_KEY: apiKeys.ANTHROPIC_API_KEY || '',
    OPENAI_API_KEY: apiKeys.OPENAI_API_KEY || '',
  })

  try {
    await waitForServer()
    const token = getAuthToken()
    log('AUTH', C.green, `Token: ${token.substring(0, 10)}...`)

    // Override MCP DB so CLI agents use experiment DB
    overrideMcpDbPath(dbPath)

    const rooms = await setup(token, apiKeys)
    if (!rooms.length) throw new Error('No rooms created')

    await runCycles(token, rooms)
    printResults(rooms)

  } finally {
    restoreMcpDbPath()
    stopServer()
    log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
  }
}

// Ctrl+C cleanup
process.on('SIGINT', () => {
  console.log('\n' + C.yellow + 'Ctrl+C received — cleaning up...' + C.reset)
  restoreMcpDbPath()
  stopServer()
  process.exit(0)
})

main().catch((err) => {
  console.error(C.red + 'Fatal: ' + err.message + C.reset)
  restoreMcpDbPath()
  stopServer()
  process.exit(1)
})
