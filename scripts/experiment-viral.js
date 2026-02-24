#!/usr/bin/env node
/**
 * Viral Experiment — Queen + 4 workers post referral link with smart thoughts
 *
 * Tests skill-saving behavior: agents learn from each other what posting
 * approaches work on each platform. All agents use Claude CLI (subscription).
 *
 * Flow:
 *   Queen generates invite link → delegates to workers:
 *   - scout:    finds active threads where Quoroom fits naturally
 *   - writer:   drafts smart comment variations (not spammy)
 *   - poster-a: posts on Reddit using quoroom_browser
 *   - poster-b: posts on dev.to / HN / GitHub discussions
 *
 *   node scripts/experiment-viral.js                  # 3 cycles, 4 workers
 *   node scripts/experiment-viral.js --cycles 5       # 5 cycles
 *   node scripts/experiment-viral.js --keep-db        # preserve DB after run
 *   node scripts/experiment-viral.js --help
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const http = require('http')

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = 3710
const TIMEOUT_MS = 90 * 60 * 1000  // 90 min — browser posting workflows take time
const MAX_TURNS = 50
const CYCLE_GAP_MS = 12000  // 12s — browser ops are slow

const GOAL = `You are a viral growth team. Your mission: publish the keeper's Quoroom referral link on social networks with smart, genuine thoughts — not spam.

Context about Quoroom:
- AI agent platform where users create "rooms" with autonomous AI agents (queens + workers)
- Agents collaborate, vote on decisions, earn revenue, and communicate across rooms
- Open source: github.com/quoroom-ai/room
- Landing page: quoroom.ai
- Built for developers who want autonomous agent teams

MISSION:
1. GENERATE THE KEEPER'S INVITE LINK
   - Call quoroom_invite_create to generate a referral link
   - Store it in memory with quoroom_remember("invite_link", ...)
   - Share it with all workers via quoroom_send_message

2. FIND RELEVANT COMMUNITIES (delegate to scout)
   - Use quoroom_web_search to find active discussions about AI agents, autonomous agents, LLM orchestration
   - Target: Reddit (r/LocalLLaMA, r/MachineLearning, r/SideProject, r/artificial), Hacker News, dev.to, GitHub Discussions
   - Find SPECIFIC threads and posts where a comment about Quoroom fits naturally — not just subreddits, but actual posts with recent activity

3. WRITE SMART COMMENTS (delegate to writer)
   - Draft 4-6 comment variations: different tones (technical, enthusiastic, curious), different angles (multi-agent coordination, revenue model, voting system)
   - Each comment should be genuinely insightful — mention something specific about the platform that makes it interesting
   - Include the invite link naturally at the end, not forced
   - Store drafts in memory so posters can use them

4. ACTUALLY POST (delegate to poster-a and poster-b)
   - Use quoroom_browser to navigate to found threads and post comments
   - Adapt the comment to fit the specific thread context
   - Record every post: platform, URL, comment text, result

COORDINATION RULES:
- Queen: generate invite link FIRST, then delegate. Track progress with quoroom_update_progress.
- Workers: check quoroom_recall for the invite link before starting. Check quoroom_list_skills for platform-specific posting algorithms.
- Every worker: message quoroom_send_message(to="keeper") with progress updates.
- When you figure out how to post on a specific platform (login flow, form selectors, CAPTCHA), create a skill immediately so teammates can reuse it.`

const TOOLS = [
  'quoroom_set_goal', 'quoroom_update_progress', 'quoroom_complete_goal', 'quoroom_create_subgoal',
  'quoroom_delegate_task',
  'quoroom_remember', 'quoroom_recall',
  'quoroom_propose', 'quoroom_vote',
  'quoroom_send_message',
  'quoroom_web_search', 'quoroom_web_fetch', 'quoroom_browser',
  'quoroom_create_skill', 'quoroom_list_skills', 'quoroom_edit_skill', 'quoroom_activate_skill',
  'quoroom_invite_create', 'quoroom_invite_list',
].join(',')

const WORKER_ROLES = [
  {
    name: 'scout',
    role: 'Platform & Thread Scout',
    focus: `Find specific, active threads and posts where a comment about Quoroom would fit naturally and add value.

Use quoroom_web_search to find recent discussions about:
- AI agent orchestration, multi-agent systems, autonomous agents
- LLM workflows, Claude tools, AI automation
- "build with AI", indie hacker tools, developer productivity
- Self-organizing AI teams, swarm intelligence

For each thread found:
- Check it's recent (last 7-30 days) and has active comments
- Assess if a Quoroom comment would be relevant (not spam)
- Store: platform, URL, thread title, why it fits, comment count

Store everything with quoroom_remember("scout: [platform] threads", ...) so posters can find them.
Also check quoroom_recall for the invite link — you'll need to include it in your scouting report.

Create a skill after each platform you research: what search queries work, what communities are active.`
  },
  {
    name: 'writer',
    role: 'Comment Writer',
    focus: `Write smart, genuine comment variations for the team to use when posting.

First: check quoroom_recall for the invite link — include it in every comment draft.
Also check quoroom_recall for scout's thread findings — tailor comments to those specific contexts.

Draft 5-6 comment variations:
1. Technical angle: "I've been building with quoroom — the multi-agent voting system is interesting because..."
2. Builder angle: "Just launched an open-source platform for autonomous agent teams — quoroom.ai — would love feedback from this community"
3. Curious angle: "Has anyone tried setting up rooms where agents vote on decisions? We built..."
4. Revenue angle: "The interesting thing about quoroom is agents can actually earn USDC..."
5. Short & punchy: one or two sentences, conversational
6. Platform-specific: tailored for a specific thread the scout found

Rules for all comments:
- Sound like a human who built this, not marketing copy
- Mention something specific and interesting about the platform
- Include the invite link naturally (e.g. "here's an invite if you want to try: [link]")
- DO NOT write spammy "check out my project" comments — they get removed and reflect badly

Store all drafts with quoroom_remember("writer: comment drafts", ...) so posters can copy-paste and adapt.`
  },
  {
    name: 'poster-a',
    role: 'Reddit Poster',
    focus: `Post comments on Reddit threads found by the scout.

Before starting:
- quoroom_recall for the invite link
- quoroom_recall for scout's Reddit thread findings
- quoroom_recall for writer's comment drafts
- quoroom_list_skills for any Reddit login or posting algorithms

Use quoroom_browser to:
1. Navigate to Reddit threads found by scout (or find new ones with quoroom_web_search)
2. Log in to Reddit (you may need to create an account first — use quoroom_browser to sign up)
3. Post an adapted version of writer's comment drafts
4. Take a screenshot after posting to confirm success

Account creation flow (if needed):
- Navigate to reddit.com/register
- Fill username, email, password
- Store credentials with quoroom_remember("poster-a: reddit credentials", ...)
- Handle any CAPTCHA with screenshot action → Read tool to view image

For each post attempt — success OR failure:
- Store result with quoroom_remember("poster-a: post [thread]", result)
- Create a skill with the exact login flow, selectors, and gotchas encountered`
  },
  {
    name: 'poster-b',
    role: 'Dev.to / HN Poster',
    focus: `Post comments on dev.to, Hacker News, and GitHub Discussions found by the scout.

Before starting:
- quoroom_recall for the invite link
- quoroom_recall for scout's dev.to / HN findings
- quoroom_recall for writer's comment drafts
- quoroom_list_skills for any existing login algorithms

Use quoroom_browser to:

DEV.TO:
- Navigate to relevant articles about AI agents, automation, LLMs
- Sign up or log in (dev.to supports GitHub OAuth — try that first)
- Post a comment using writer's drafts as a base, adapted to the article

HACKER NEWS:
- Find relevant "Show HN" or "Ask HN" threads via quoroom_web_search
- Log in to HN (or create account at news.ycombinator.com)
- Post a comment — HN tone: technical, skeptical-friendly, no hype

GITHUB DISCUSSIONS (if time):
- Find repos discussing AI agent frameworks
- Comment in their Discussions tab

For each post:
- Store result with quoroom_remember("poster-b: post [platform] [thread]", ...)
- Create a skill with exact selectors and login flow for that platform`
  }
]

// ─── Colors ──────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
}
const COLORS = [C.cyan, C.yellow, C.magenta, C.green, C.blue]

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
const keepDb = args.includes('--keep-db')

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ─── Build ────────────────────────────────────────────────────────────────────

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

// ─── MCP DB override ──────────────────────────────────────────────────────────

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

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let serverProcess = null
let dataDir = null
let dbPath = null

function startServer() {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-viral-${ts}`
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

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup(token) {
  log('SETUP', C.bold, `Creating room with queen + ${WORKER_ROLES.length} workers (all claude CLI)...`)

  // Create room
  const res = await api('POST', '/api/rooms', { name: 'viral-team', goal: GOAL }, token)
  if (res.status !== 200 && res.status !== 201) {
    log('SETUP', C.red, `FAILED: ${JSON.stringify(res.data).substring(0, 200)}`)
    return null
  }
  const room = res.data.room || res.data
  const queen = res.data.queen

  log('SETUP', C.cyan, `Room #${room.id}, queen #${queen.id}`)

  // Configure queen
  await api('PATCH', `/api/workers/${queen.id}`, { model: 'claude', name: 'queen' }, token)

  // Room config — allow invite tools, browser, skills
  await api('PATCH', `/api/rooms/${room.id}`, {
    workerModel: 'claude',
    queenCycleGapMs: CYCLE_GAP_MS,
    queenMaxTurns: MAX_TURNS,
    allowedTools: TOOLS,
    config: { autoApprove: ['low_impact'], minVoters: 1 }
  }, token)

  const agents = [{
    name: 'queen', workerId: queen.id, roomId: room.id,
    color: COLORS[0], isQueen: true, role: 'Viral Coordinator'
  }]

  // Create workers
  for (let i = 0; i < WORKER_ROLES.length; i++) {
    const r = WORKER_ROLES[i]
    const color = COLORS[(i + 1) % COLORS.length]

    const workerRes = await api('POST', '/api/workers', {
      name: r.name,
      systemPrompt: `You are "${r.name}" — the ${r.role} in a viral growth team for Quoroom.

YOUR FOCUS: ${r.focus}

Before you start each cycle:
- Check quoroom_list_skills — another agent may have already documented what you need
- Check quoroom_recall for the invite link, scout findings, and writer's comment drafts
- Don't repeat work that's already done

Store results immediately:
- Use quoroom_remember("${r.name}: [what]", ...) so teammates can find your work
- Message teammates with quoroom_send_message when you have something they need

MANDATORY — Execution Report (every cycle):
Before your cycle ends, call quoroom_create_skill with a report:
- Title: "${r.name}: [task] — [platform/site]"
- Body: what you tried, what FAILED (exact errors/selectors), what WORKED (exact steps)
- Set autoActivate: true, activationContext: relevant keywords
- Even if you failed — document it so others don't repeat the mistake`,
      roomId: room.id,
      maxTurns: MAX_TURNS,
      cycleGapMs: CYCLE_GAP_MS
    }, token)

    if (workerRes.status !== 201) {
      log(r.name, C.red, `Failed to create: ${JSON.stringify(workerRes.data).substring(0, 200)}`)
      continue
    }

    const worker = workerRes.data
    await api('PATCH', `/api/workers/${worker.id}`, { model: 'claude' }, token)
    agents.push({ name: r.name, workerId: worker.id, roomId: room.id, color, isQueen: false, role: r.role })
    log(r.name, color, `Worker #${worker.id} — ${r.role}`)
  }

  return { roomId: room.id, queenId: queen.id, agents }
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

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

  // Stagger worker starts — give queen time to generate invite link first
  await sleep(3000)
  for (const a of agents.filter(a => !a.isQueen)) {
    const res = await api('POST', `/api/workers/${a.workerId}/start`, {}, token)
    log(a.name, a.color, res.status === 200 ? 'Started' : `FAIL: ${JSON.stringify(res.data)}`)
    await sleep(2000)
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
    await sleep(3000)

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

// ─── Results ──────────────────────────────────────────────────────────────────

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
  console.log(`  VIRAL EXPERIMENT RESULTS - ${now}`)
  console.log(`  Agents: ${agents.length} (all claude CLI) | Target cycles: ${numCycles}`)
  console.log('='.repeat(80))

  // Per-agent summary
  console.log('')
  console.log('  ' + pad('Agent', 18) + pad('Role', 28) + pad('Cycles', 8) + pad('Tools', 10) + pad('Browser', 8))
  console.log('  ' + '-'.repeat(72))

  for (const agent of agents) {
    const cycles = db.prepare(
      'SELECT id, status FROM worker_cycles WHERE worker_id = ? AND room_id = ?'
    ).all(agent.workerId, roomId)
    const done = cycles.filter(c => c.status === 'completed' || c.status === 'failed').length

    let toolCalls = 0
    let browserCalls = 0
    for (const c of cycles) {
      toolCalls += db.prepare("SELECT COUNT(*) as cnt FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call'").get(c.id).cnt
      browserCalls += db.prepare("SELECT COUNT(*) as cnt FROM cycle_logs WHERE cycle_id = ? AND entry_type = 'tool_call' AND content LIKE '%browser%'").get(c.id).cnt
    }

    console.log('  ' + pad(agent.name, 18) + pad(agent.role.substring(0, 26), 28) + pad(String(done), 8) + pad(String(toolCalls), 10) + pad(String(browserCalls), 8))
  }

  // Collaboration stats
  const interWorker = db.prepare('SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NOT NULL').get(roomId)
  const keeper = db.prepare('SELECT COUNT(*) as cnt FROM escalations WHERE room_id = ? AND to_agent_id IS NULL').get(roomId)
  const votes = db.prepare('SELECT COUNT(*) as cnt FROM quorum_votes WHERE decision_id IN (SELECT id FROM quorum_decisions WHERE room_id = ?)').get(roomId)
  const proposals = db.prepare('SELECT COUNT(*) as cnt FROM quorum_decisions WHERE room_id = ?').get(roomId)
  const memories = db.prepare("SELECT COUNT(*) as cnt FROM entities WHERE room_id = ? AND name != 'queen_session_summary'").get(roomId)

  console.log('')
  console.log('  COLLABORATION')
  console.log('  ' + '-'.repeat(40))
  console.log(`  Inter-worker messages:  ${interWorker.cnt}`)
  console.log(`  Keeper messages:        ${keeper.cnt}`)
  console.log(`  Proposals:              ${proposals.cnt}`)
  console.log(`  Votes cast:             ${votes.cnt}`)
  console.log(`  Shared memories:        ${memories.cnt}`)

  // Skills created — this is the key metric for this experiment
  const skills = db.prepare('SELECT name, content, auto_activate FROM skills WHERE room_id = ? ORDER BY id').all(roomId)
  console.log('')
  console.log('  SKILLS CREATED — ' + C.bold + skills.length + ' total' + C.reset)
  console.log('  ' + '-'.repeat(60))
  for (const s of skills) {
    const preview = (s.content || '').replace(/\n/g, ' ').substring(0, 100)
    const autoFlag = s.auto_activate ? `${C.green}[auto]${C.reset}` : `${C.dim}[manual]${C.reset}`
    console.log(`  ${autoFlag} ${C.cyan}${s.name}${C.reset}`)
    console.log(`         ${C.dim}${preview}${C.reset}`)
  }

  // Memory dump
  const entities = db.prepare(
    "SELECT e.name, o.content FROM entities e JOIN observations o ON o.entity_id = e.id WHERE e.room_id = ? AND e.name != 'queen_session_summary' ORDER BY e.id"
  ).all(roomId)

  if (entities.length > 0) {
    console.log('')
    console.log('='.repeat(80))
    console.log('  MEMORY DUMP — What agents found and stored')
    console.log('='.repeat(80))
    console.log('')
    console.log(`  ${C.bold}${entities.length} memories total${C.reset}:`)
    for (const e of entities) {
      const preview = (e.content || '').replace(/\n/g, ' ').substring(0, 120)
      console.log(`    ${C.cyan}${e.name}${C.reset}: ${C.dim}${preview}${C.reset}`)
    }
  }

  // Invite links generated
  const invites = db.prepare('SELECT code, used_count FROM invites WHERE room_id = ? ORDER BY id').all(roomId)
  if (invites.length > 0) {
    console.log('')
    console.log('  INVITE LINKS GENERATED')
    console.log('  ' + '-'.repeat(40))
    for (const inv of invites) {
      console.log(`  quoroom.ai/join/${inv.code}  (used: ${inv.used_count})`)
    }
  }

  db.close()
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}Viral Experiment${C.reset} — ${numCycles} cycles, 1 queen + ${WORKER_ROLES.length} workers (all claude CLI)`)
  console.log(`Goal: post keeper's referral link on social networks with smart thoughts\n`)

  build()
  startServer()

  try {
    await waitForServer()
    const token = getAuthToken()
    log('AUTH', C.green, `Token: ${token.substring(0, 10)}...`)

    overrideMcpDbPath(dbPath)

    const swarm = await setup(token)
    if (!swarm) throw new Error('Setup failed')

    await runCycles(token, swarm)
    printResults(swarm)

  } finally {
    restoreMcpDbPath()
    stopServer()

    if (keepDb) {
      log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
    } else if (dbPath && existsSync(dbPath)) {
      log('CLEANUP', C.dim, `DB preserved: ${dbPath}`)
    }
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
