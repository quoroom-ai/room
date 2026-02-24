#!/usr/bin/env node
/**
 * Growth Experiment — 11 Claude agents brainstorming Quoroom user growth
 *
 * All agents use Claude CLI (subscription model). No API keys needed.
 *
 *   node scripts/experiment-growth.js                  # 3 cycles, 11 agents
 *   node scripts/experiment-growth.js --cycles 5       # 5 cycles
 *   node scripts/experiment-growth.js --workers 5      # fewer workers
 *   node scripts/experiment-growth.js --keep-db        # preserve DB
 *   node scripts/experiment-growth.js --help
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const http = require('http')

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = 3710
const TIMEOUT_MS = 30 * 60 * 1000  // 30 min (11 CLI agents take time)
const MAX_TURNS = 50
const CYCLE_GAP_MS = 8000  // 8s gap — CLI agents are slower

const GOAL = `You are a growth team for Quoroom — an AI agent platform where users create "rooms" with autonomous AI agents (queens + workers) that collaborate, vote on decisions, earn revenue, and communicate across rooms.

YOUR MISSION: Find concrete, actionable ways to grow Quoroom's user base from 0 to 1000 users.

Context about Quoroom:
- Users create rooms with AI agents that autonomously pursue goals
- Agents can: do web research, manage goals, vote on decisions, message each other, message the keeper (human owner), send inter-room messages
- Revenue model: users pay for "stations" (cloud compute for API-based agents)
- Each room has a USDC wallet — agents can earn and spend
- Rooms can network with each other via invite links
- Free tier exists: CLI agents (Claude, Codex) run locally for free
- The product is open source (GitHub: quoroom-ai/room)
- Landing page: quoroom.ai

Research areas to divide among the team:
1. Developer community growth (GitHub, HN, Reddit, Discord)
2. Content marketing (blog posts, tutorials, demo videos)
3. Partnership opportunities (AI companies, dev tools, cloud providers)
4. Product-led growth (viral mechanics, invite system, public rooms directory)
5. Paid acquisition channels and unit economics
6. Competitive landscape (similar products, positioning)
7. Community building (Discord, forums, meetups)
8. SEO and organic search strategy
9. Influencer and thought leader outreach
10. Launch strategy (Product Hunt, HN Show, Twitter/X)

RULES:
- Each worker should OWN a specific area — don't duplicate work
- Use quoroom_web_search to research real data (competitor pricing, community sizes, etc.)
- Store all findings in memory with quoroom_remember so the whole team benefits
- Message the keeper with actionable recommendations, not vague ideas
- Vote on proposed strategies via quoroom_propose — the team must agree
- Deliver a final growth playbook to the keeper by the last cycle`

const TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal', 'quoroom_create_subgoal',
  'quoroom_delegate_task',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_propose', 'quoroom_vote',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch',
].join(',')

const WORKER_ROLES = [
  { name: 'dev-community', role: 'Developer Community & Open Source Growth', focus: 'GitHub stars, HN launches, Reddit presence, Discord community building. Research what worked for similar open-source AI projects.' },
  { name: 'content', role: 'Content Marketing & SEO', focus: 'Blog strategy, tutorials, demo videos, SEO keywords. Research what content performs best for dev tools and AI products.' },
  { name: 'partnerships', role: 'Partnerships & Integrations', focus: 'AI company partnerships, dev tool integrations, cloud provider programs. Research partner programs at Anthropic, OpenAI, Vercel, etc.' },
  { name: 'product-growth', role: 'Product-Led Growth & Virality', focus: 'Invite mechanics, public rooms, viral loops, free-to-paid conversion. Research PLG playbooks from successful dev tools.' },
  { name: 'paid-acq', role: 'Paid Acquisition & Economics', focus: 'Ad channels, CAC targets, LTV modeling, budget allocation. Research what channels work for dev tools (Google Ads, Twitter, LinkedIn).' },
  { name: 'competitive', role: 'Competitive Intelligence', focus: 'Map all competitors (AutoGPT, CrewAI, LangGraph, etc.), their pricing, positioning, weaknesses. Find our unique angle.' },
  { name: 'community', role: 'Community Building & Engagement', focus: 'Discord strategy, office hours, hackathons, ambassador program. Research community playbooks from Vercel, Supabase, etc.' },
  { name: 'launch', role: 'Launch Strategy & PR', focus: 'Product Hunt launch, HN Show post, Twitter/X strategy, press outreach. Research successful AI product launches.' },
  { name: 'influencer', role: 'Influencer & Thought Leader Outreach', focus: 'AI YouTubers, Twitter influencers, newsletter writers. Research who covers AI agent tools and how to reach them.' },
  { name: 'enterprise', role: 'Enterprise & B2B Strategy', focus: 'Enterprise use cases, pricing for teams, compliance needs, pilot programs. Research what enterprises want from AI agent platforms.' },
]

// ─── Colors ──────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
}
const COLORS = [C.cyan, C.yellow, C.magenta, C.green, C.blue, C.red,
  '\x1b[38;5;208m', '\x1b[38;5;141m', '\x1b[38;5;117m', '\x1b[38;5;220m', '\x1b[38;5;168m']

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

const numCycles = parseInt(getArg('--cycles') || '3', 10)
const numWorkers = parseInt(getArg('--workers') || '10', 10)
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

function startServer() {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-growth-${ts}`
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

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup(token) {
  log('SETUP', C.bold, `Creating room with queen + ${numWorkers} workers (all claude CLI)...`)

  // Create room
  const res = await api('POST', '/api/rooms', { name: 'growth-team', goal: GOAL }, token)
  if (res.status !== 200 && res.status !== 201) {
    log('SETUP', C.red, `FAILED: ${JSON.stringify(res.data).substring(0, 200)}`)
    return null
  }
  const room = res.data.room || res.data
  const queen = res.data.queen

  log('SETUP', C.cyan, `Room #${room.id}, queen #${queen.id}`)

  // Configure queen
  await api('PATCH', `/api/workers/${queen.id}`, { model: 'claude', name: 'queen' }, token)

  // Room config: real voting, tools
  await api('PATCH', `/api/rooms/${room.id}`, {
    workerModel: 'claude',
    queenCycleGapMs: CYCLE_GAP_MS,
    queenMaxTurns: MAX_TURNS,
    allowedTools: TOOLS,
    config: { autoApprove: [], minVoters: 3 }  // need 3+ votes with 11 agents
  }, token)

  // Build agent list
  const agents = [{
    name: 'queen', workerId: queen.id, roomId: room.id,
    color: COLORS[0], isQueen: true, role: 'Strategic Coordinator'
  }]

  // Create workers
  const roles = WORKER_ROLES.slice(0, numWorkers)
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i]
    const color = COLORS[(i + 1) % COLORS.length]

    const workerRes = await api('POST', '/api/workers', {
      name: r.name,
      systemPrompt: `You are "${r.name}" — the ${r.role} specialist in an 11-agent growth team for Quoroom.

YOUR FOCUS AREA: ${r.focus}

You are one of 10 workers + 1 queen. Each worker owns a specific growth area. Your job:
1. Research your area deeply using quoroom_web_search and quoroom_web_fetch
2. Store all findings in memory with quoroom_remember (name them clearly, e.g. "${r.name}: [topic]")
3. Propose strategies via quoroom_propose and vote on others' proposals with quoroom_vote
4. Message teammates with relevant findings: quoroom_send_message(to="worker-name")
5. Report key insights to the keeper: quoroom_send_message(to="keeper")
6. Complete any tasks assigned to you (check "Your Assigned Tasks" in context)

Be specific and data-driven. Include real numbers, URLs, competitor names, pricing data.
Don't repeat what others have already found — check shared memory with quoroom_recall first.`,
      roomId: room.id,
      maxTurns: MAX_TURNS,
      cycleGapMs: CYCLE_GAP_MS
    }, token)

    if (workerRes.status !== 201) {
      log(r.name, C.red, `Failed: ${JSON.stringify(workerRes.data).substring(0, 200)}`)
      continue
    }

    const worker = workerRes.data
    await api('PATCH', `/api/workers/${worker.id}`, { model: 'claude' }, token)
    agents.push({ name: r.name, workerId: worker.id, roomId: room.id, color, isQueen: false, role: r.role })
    log(r.name, color, `Worker #${worker.id} — ${r.role}`)
  }

  return { roomId: room.id, queenId: queen.id, agents }
}

// ─── Monitor ─────────────────────────────────────────────────────────────────

async function runCycles(token, swarm) {
  const Database = require('better-sqlite3')
  const { roomId, agents } = swarm

  console.log('')
  log('RUN', C.bold, `Starting ${agents.length} agents for ${numCycles} cycle(s) each...`)
  console.log('')

  // Start queen
  const queenAgent = agents.find(a => a.isQueen)
  await api('POST', `/api/rooms/${roomId}/queen/start`, {}, token)
  log(queenAgent.name, queenAgent.color, 'Queen started')

  // Stagger worker starts to avoid overwhelming Claude CLI
  for (const a of agents.filter(a => !a.isQueen)) {
    const res = await api('POST', `/api/workers/${a.workerId}/start`, {}, token)
    log(a.name, a.color, res.status === 200 ? 'Started' : `FAIL: ${JSON.stringify(res.data)}`)
    await sleep(1000)  // 1s stagger between CLI agents
  }

  console.log('')
  log('RUN', C.bold, 'Monitoring all agents live...')
  console.log('─'.repeat(80))

  const start = Date.now()
  const lastLogSeq = {}
  const printedCycles = new Set()
  const completedCycles = new Set()
  const stoppedAgents = new Set()

  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(3000)  // poll every 3s (11 agents = lots of data)

    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    let allDone = true

    for (const agent of agents) {
      const cycles = db.prepare(
        'SELECT id, status, duration_ms, input_tokens, output_tokens, error_message FROM worker_cycles WHERE worker_id = ? AND room_id = ? ORDER BY id'
      ).all(agent.workerId, roomId)

      const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length
      if (done < numCycles) allDone = false

      if (done >= numCycles && !stoppedAgents.has(agent.workerId)) {
        stoppedAgents.add(agent.workerId)
        if (agent.isQueen) {
          api('POST', `/api/rooms/${roomId}/queen/stop`, {}, token).catch(() => {})
        } else {
          api('POST', `/api/workers/${agent.workerId}/stop`, {}, token).catch(() => {})
        }
        log(agent.name, agent.color, `${C.bold}── Target ${numCycles} cycle(s) reached — stopped ──${C.reset}`)
      }

      for (const cycle of cycles) {
        if (!printedCycles.has(cycle.id)) {
          printedCycles.add(cycle.id)
          const cycleNum = cycles.indexOf(cycle) + 1
          console.log('')
          log(agent.name, agent.color, `${C.bold}── Cycle ${cycleNum} (id=${cycle.id}) ──${C.reset}`)
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
              log(agent.name, agent.color, `  -> ${C.cyan}${content.substring(0, 200)}${C.reset}`)
              break
            case 'tool_result':
              log(agent.name, agent.color, `  <- ${C.dim}${content.substring(0, 300)}${C.reset}`)
              break
            case 'assistant_text':
              log(agent.name, agent.color, `  ${C.white}${content.substring(0, 400)}${C.reset}`)
              break
            case 'error':
              log(agent.name, C.red, `  ERROR: ${content.substring(0, 300)}`)
              break
            default:
              log(agent.name, agent.color, `  [${entry.entry_type}] ${content.substring(0, 200)}`)
          }
        }

        if ((cycle.status === 'completed' || cycle.status === 'failed') && !completedCycles.has(cycle.id)) {
          completedCycles.add(cycle.id)
          const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
          if (cycle.status === 'completed') {
            log(agent.name, agent.color, `${C.bold}── Done: ${dur}s ──${C.reset}`)
          } else {
            log(agent.name, C.red, `${C.bold}── FAILED: ${cycle.error_message || 'unknown'} ──${C.reset}`)
          }
        }
      }
    }

    db.close()
    if (allDone) {
      console.log('')
      log('RUN', C.green + C.bold, 'All agents completed!')
      return
    }
  }

  console.log('')
  log('RUN', C.red, 'TIMEOUT — some agents did not complete')
}

// ─── Results ─────────────────────────────────────────────────────────────────

function fmtK(n) {
  if (!n || n === 0) return '?'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function pad(s, w) {
  if (s.length >= w) return s.substring(0, w - 1) + ' '
  return s + ' '.repeat(w - s.length)
}

function printResults(swarm) {
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const { roomId, agents } = swarm

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  console.log('\n' + '='.repeat(80))
  console.log(`  GROWTH EXPERIMENT RESULTS - ${now}`)
  console.log(`  Agents: ${agents.length} (all claude CLI) | Target cycles: ${numCycles}`)
  console.log('='.repeat(80))

  // Per-agent summary
  console.log('')
  console.log('  ' + pad('Agent', 16) + pad('Role', 30) + pad('Cycles', 8) + pad('Tools', 8) + pad('Msgs', 8))
  console.log('  ' + '-'.repeat(70))

  for (const agent of agents) {
    const cycles = db.prepare(
      'SELECT id, status FROM worker_cycles WHERE worker_id = ? AND room_id = ?'
    ).all(agent.workerId, roomId)
    const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length

    let toolCalls = 0
    for (const c of cycles) {
      toolCalls += db.prepare("SELECT COUNT(*) as cnt FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'").get(c.id).cnt
    }

    const msgs = db.prepare('SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND from_agent_id = ?').get(roomId, agent.workerId)

    console.log('  ' + pad(agent.name, 16) + pad(agent.role.substring(0, 28), 30) + pad(String(done), 8) + pad(String(toolCalls), 8) + pad(String(msgs.cnt), 8))
  }

  // Collaboration
  const interWorker = db.prepare('SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NOT NULL').get(roomId)
  const keeper = db.prepare('SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NULL').get(roomId)
  const votes = db.prepare('SELECT COUNT(*) as cnt FROM quorum_votes WHERE decision_id IN (SELECT id FROM quorum_decisions WHERE room_id = ?)').get(roomId)
  const proposals = db.prepare('SELECT COUNT(*) as cnt FROM quorum_decisions WHERE room_id = ?').get(roomId)
  const memories = db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE room_id = ?').get(roomId)
  const goals = db.prepare('SELECT id, status FROM goals WHERE room_id = ?').all(roomId)

  console.log('')
  console.log('  COLLABORATION')
  console.log('  ' + '-'.repeat(40))
  console.log(`  Inter-worker messages:  ${interWorker.cnt}`)
  console.log(`  Keeper messages:        ${keeper.cnt}`)
  console.log(`  Proposals:              ${proposals.cnt}`)
  console.log(`  Votes cast:             ${votes.cnt}`)
  console.log(`  Shared memories:        ${memories.cnt}`)
  console.log(`  Goals (made/done):      ${goals.length}/${goals.filter(g => g.status === 'completed').length}`)

  // Decisions
  const decisions = db.prepare('SELECT id, proposal, status, result FROM quorum_decisions WHERE room_id = ? ORDER BY id').all(roomId)
  if (decisions.length > 0) {
    console.log('')
    console.log('  PROPOSALS & VOTES')
    console.log('  ' + '-'.repeat(40))
    for (const d of decisions) {
      const shortProposal = d.proposal.replace(/\n/g, ' ').substring(0, 70)
      console.log(`  #${d.id} [${d.status}] ${shortProposal}...`)
      if (d.result) console.log(`     ${C.dim}${d.result}${C.reset}`)
    }
  }

  // Memory dump
  console.log('')
  console.log('='.repeat(80))
  console.log('  MEMORY DUMP — Research findings stored by agents')
  console.log('='.repeat(80))

  const entities = db.prepare(
    "SELECT e.name, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND e.name != 'queen_session_summary' ORDER BY e.id"
  ).all(roomId)

  console.log(`\n  ${C.bold}${entities.length} memories total${C.reset}:`)
  for (const e of entities) {
    const preview = (e.content || '').replace(/\n/g, ' ').substring(0, 120)
    console.log(`    ${C.cyan}${e.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
  }
  console.log('')

  db.close()
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log(`${C.bold}Growth Experiment${C.reset} — ${numCycles} cycles, 1 queen + ${numWorkers} workers (all claude CLI)`)
  console.log(`Goal: "Find concrete ways to grow Quoroom from 0 to 1000 users"`)
  console.log('')

  // Build
  build()

  // Start server
  startServer()
  await waitForServer()

  const token = getAuthToken()
  log('AUTH', C.green, `Token: ${token.substring(0, 10)}...`)

  // Override MCP DB
  overrideMcpDbPath(dbPath)

  // Setup
  const swarm = await setup(token)
  if (!swarm) {
    log('SETUP', C.red, 'Setup failed!')
    stopServer()
    process.exit(1)
  }

  // Run
  await runCycles(token, swarm)

  // Results
  printResults(swarm)

  // Cleanup
  restoreMcpDbPath()
  stopServer()
  if (keepDb) {
    log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
  } else {
    try { rmSync(dataDir, { recursive: true }) } catch {}
    log('CLEANUP', C.dim, 'Temp DB cleaned up.')
  }
}

// Clean shutdown
process.on('SIGINT', () => {
  console.log(`\n${C.yellow}Interrupted — cleaning up...${C.reset}`)
  restoreMcpDbPath()
  stopServer()
  if (!keepDb && dataDir) { try { rmSync(dataDir, { recursive: true }) } catch {} }
  process.exit(0)
})
process.on('SIGTERM', () => { restoreMcpDbPath(); stopServer(); process.exit(0) })

main().catch(err => {
  restoreMcpDbPath()
  console.error(`\n${C.red}Failed: ${err.message}${C.reset}`)
  if (err.stack) console.error(C.dim + err.stack + C.reset)
  stopServer()
  process.exit(1)
})
