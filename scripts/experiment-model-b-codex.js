#!/usr/bin/env node
/**
 * Model B Controller Experiment (Codex-only, capped cycles)
 *
 * Validates queen control-plane behavior with the new Model B logic:
 * - Queen auto-bootstraps an executor when alone.
 * - Queen delegates execution to workers (not direct execution).
 * - Worker executes delegated tasks.
 * - Legacy voting endpoint still accepts worker votes.
 *
 * Constraints:
 * - Uses Codex subscription model only.
 * - Hard cap: 2-3 queen cycles.
 *
 * Usage:
 *   node scripts/experiment-model-b-codex.js
 *   node scripts/experiment-model-b-codex.js --cycles 2
 *   node scripts/experiment-model-b-codex.js --keep-db
 */

const { spawn, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('fs')
const { homedir } = require('os')
const path = require('path')
const http = require('http')

const PORT = 3710
const POLL_MS = 2000
const TIMEOUT_MS = 30 * 60 * 1000
const CYCLE_GAP_MS = 6000
const MAX_TURNS = 50

const GOAL = `Model B controller-only validation.

Queen requirements:
- Stay control-plane focused.
- Delegate execution to workers using quoroom_delegate_task.
- Poke workers with quoroom_send_message.
- Keep a short governance heartbeat with quoroom_announce when appropriate.

Worker requirements:
- Execute delegated tasks with quoroom_web_search / quoroom_web_fetch.
- Store concrete findings with quoroom_remember.
- Report progress and complete delegated goals.`

const QUEEN_SYSTEM_PROMPT = `You are the queen in Model B controller mode.

Rules:
1) If a non-queen worker exists, delegate one concrete task every cycle with quoroom_delegate_task.
2) After delegating, send a direct poke/follow-up to that worker with quoroom_send_message.
3) Keep governance active: announce one low-impact room rule when useful.
4) Do not execute web search/fetch/browser directly unless strictly unavoidable.
5) Always save cycle continuity with quoroom_save_wip.

When delegation tools are temporarily unavailable, save WIP and wait for next cycle.`

const EXECUTOR_SYSTEM_PROMPT = `You are the room executor.

For each delegated goal:
1) Execute immediately with quoroom_web_search and optional quoroom_web_fetch.
2) Store at least one concrete result using quoroom_remember.
3) Send a short progress update to queen.
4) Complete the delegated goal when done.
5) Save WIP at cycle end.`

const PHASE1_TOOLS = [
  'quoroom_set_goal',
  'quoroom_complete_goal',
  'quoroom_remember',
  'quoroom_recall',
  'quoroom_save_wip',
].join(',')

const PHASE2_TOOLS = [
  'quoroom_set_goal',
  'quoroom_delegate_task',
  'quoroom_complete_goal',
  'quoroom_announce',
  'quoroom_object',
  'quoroom_remember',
  'quoroom_recall',
  'quoroom_send_message',
  'quoroom_web_search',
  'quoroom_web_fetch',
  'quoroom_save_wip',
].join(',')

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
}

function log(prefix, color, msg) {
  const ts = new Date().toISOString().substring(11, 19)
  console.log(`${C.dim}${ts}${C.reset} ${color}${prefix}${C.reset} ${msg}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', (d) => { data += d })
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
  const short = urlPath.length > 58 ? `${urlPath.slice(0, 55)}...` : urlPath
  const ok = res.status >= 200 && res.status < 300
  log('API', C.dim, `${method} ${short} ${ok ? C.green : C.red}${res.status}${C.reset}${ok ? '' : ` ${JSON.stringify(res.data).slice(0, 140)}`}`)
  return res
}

function getArg(args, name) {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}

function parseCycleCount(raw) {
  const parsed = Number.parseInt(raw || '3', 10)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(2, Math.min(3, parsed))
}

function parseToolName(content) {
  const m = content.match(/(?:→ |Using )([a-zA-Z0-9_]+)/)
  return m ? m[1] : null
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  const src = readFileSync(__filename, 'utf8')
  const help = src.match(/\/\*\*([\s\S]*?)\*\//)
  if (help) console.log(help[1].replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}

const keepDb = args.includes('--keep-db')
const numCycles = parseCycleCount(getArg(args, '--cycles'))

const PROJECT_ROOT = path.resolve(__dirname, '..')
const EXTERNALS = ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'onnxruntime-node', 'playwright', 'playwright-core']
const { version } = require(path.join(PROJECT_ROOT, 'package.json'))

let serverProcess = null
let dataDir = null
let dbPath = null
const CODEX_CONFIG_PATH = path.join(homedir(), '.codex', 'config.toml')
let originalCodexConfig = null

function build() {
  log('BUILD', C.blue, 'Compiling local server bundles with esbuild...')
  const ext = EXTERNALS.map((e) => `--external:${e}`).join(' ')
  const define = `--define:__APP_VERSION__='"${version}"'`
  const common = `--bundle --platform=node --target=node18 ${ext} ${define}`
  execSync(`npx esbuild src/mcp/server.ts ${common} --outfile=out/mcp/server.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  execSync(`npx esbuild src/cli/index.ts ${common} --outfile=out/mcp/cli.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  execSync(`npx esbuild src/server/index.ts ${common} --external:ws --outfile=out/mcp/api-server.js`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
  log('BUILD', C.blue, 'Build complete.')
}

function startServer() {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'pipe' }) } catch {}

  const ts = Date.now()
  dataDir = `/tmp/quoroom-model-b-codex-${ts}`
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
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const tokenFile = path.join(dataDir, 'api.token')
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (existsSync(tokenFile) && existsSync(dbPath)) break
    await sleep(500)
  }
  if (!existsSync(tokenFile)) throw new Error('Server did not produce api.token')

  while (Date.now() - start < maxWaitMs) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim()
      const res = await request('GET', '/api/rooms', null, token)
      if (res.status === 200 || res.status === 401) {
        log('SERVER', C.green, `Ready in ${((Date.now() - start) / 1000).toFixed(1)}s`)
        return
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('Server did not respond within timeout')
}

function getToken() {
  return readFileSync(path.join(dataDir, 'api.token'), 'utf8').trim()
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

function tomlLiteral(value) {
  return String(value).replace(/'/g, "''")
}

function patchCodexConfig(experimentDbPath) {
  if (!existsSync(CODEX_CONFIG_PATH)) {
    throw new Error(`Codex config not found at ${CODEX_CONFIG_PATH}`)
  }
  const raw = readFileSync(CODEX_CONFIG_PATH, 'utf8')
  originalCodexConfig = raw

  const lines = raw.split('\n')
  const filtered = []
  let inQuoroomSection = false
  for (const line of lines) {
    if (/^\[mcp_servers\.quoroom[\].]/.test(line)) {
      inQuoroomSection = true
      continue
    }
    if (inQuoroomSection && /^\[/.test(line)) {
      inQuoroomSection = false
    }
    if (!inQuoroomSection) filtered.push(line)
  }

  const nodePath = tomlLiteral(process.execPath)
  const mcpServerPath = tomlLiteral(path.join(PROJECT_ROOT, 'out/mcp/server.js'))
  const dbLiteral = tomlLiteral(experimentDbPath)
  let content = filtered.join('\n').trimEnd()
  content += `\n\n[mcp_servers.quoroom]\ncommand = '${nodePath}'\nargs = ['${mcpServerPath}']\n\n[mcp_servers.quoroom.env]\nQUOROOM_DB_PATH = '${dbLiteral}'\nQUOROOM_SOURCE = "codex"\n`
  writeFileSync(CODEX_CONFIG_PATH, content)
  log('MCP', C.green, `Patched Codex MCP config for DB ${experimentDbPath}`)
}

function restoreCodexConfig() {
  if (originalCodexConfig == null) return
  try {
    writeFileSync(CODEX_CONFIG_PATH, originalCodexConfig)
    log('MCP', C.dim, 'Restored original Codex config.')
  } catch (e) {
    log('MCP', C.yellow, `Could not restore Codex config: ${e.message}`)
  }
  originalCodexConfig = null
}

async function runLegacyVotingCheck(token, roomId, workerId) {
  const create = await api('POST', `/api/rooms/${roomId}/decisions`, {
    proposerId: workerId,
    proposal: `Legacy voting check ${Date.now()}`,
    decisionType: 'strategy',
  }, token)
  if (create.status !== 201) return { passed: false, reason: 'create_failed' }
  const decision = create.data
  const vote = await api('POST', `/api/decisions/${decision.id}/vote`, {
    workerId,
    vote: 'no',
    reasoning: 'Regression check from codex experiment',
  }, token)
  if (vote.status !== 201) return { passed: false, reason: 'vote_failed', decisionId: decision.id }
  const votes = await api('GET', `/api/decisions/${decision.id}/votes`, null, token)
  const hasNoVote = votes.status === 200 && Array.isArray(votes.data) && votes.data.some((v) => v.workerId === workerId && v.vote === 'no')
  return {
    passed: hasNoVote,
    reason: hasNoVote ? 'ok' : 'vote_not_found',
    decisionId: decision.id,
  }
}

async function main() {
  console.log('')
  console.log(`${C.bold}${C.cyan}╔═════════════════════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}${C.cyan}║   Model B Queen Controller Experiment (Codex-only)              ║${C.reset}`)
  console.log(`${C.bold}${C.cyan}╚═════════════════════════════════════════════════════════════════╝${C.reset}`)
  console.log(`${C.dim}  Cycles (queen hard cap): ${numCycles}`)
  console.log(`  Worker model policy: codex only`)
  console.log(`  Goal: bootstrap -> delegate -> execute -> verify${C.reset}`)
  console.log('')

  build()
  startServer()
  await waitForServer()
  const token = getToken()

  patchCodexConfig(dbPath)

  const create = await api('POST', '/api/rooms', {
    name: 'model-b-codex',
    goal: GOAL,
    queenSystemPrompt: QUEEN_SYSTEM_PROMPT,
  }, token)
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(`Room creation failed: ${JSON.stringify(create.data)}`)
  }
  const room = create.data.room || create.data
  const queen = create.data.queen
  log('SETUP', C.green, `Room #${room.id}, Queen #${queen.id}`)

  await api('PATCH', `/api/workers/${queen.id}`, { model: 'codex', systemPrompt: QUEEN_SYSTEM_PROMPT, name: 'queen' }, token)
  await api('PATCH', `/api/rooms/${room.id}`, {
    workerModel: 'codex',
    queenCycleGapMs: CYCLE_GAP_MS,
    queenMaxTurns: MAX_TURNS,
    allowedTools: PHASE1_TOOLS,
    config: { autoApprove: [], minVoters: 1 },
  }, token)

  const queenStatus = await api('GET', `/api/rooms/${room.id}/queen`, null, token)
  if (queenStatus.status === 200) {
    const auth = queenStatus.data.auth || {}
    log('AUTH', C.cyan, `Queen model=${queenStatus.data.model}, provider=${auth.provider || 'unknown'}, ready=${String(auth.ready)}`)
  }

  log('RUN', C.bold, 'Starting room runtime...')
  await api('POST', `/api/rooms/${room.id}/start`, {}, token)
  console.log('─'.repeat(92))

  const Database = require('better-sqlite3')
  const startTs = Date.now()
  const seenCycleStarts = new Set()
  const seenCycleEnds = new Set()
  const lastLogSeq = new Map()

  let phase2Enabled = false
  let bootstrapWorkerId = null
  let legacyVoting = { passed: false, reason: 'not_run', decisionId: null }
  let stopSent = false

  while (Date.now() - startTs < TIMEOUT_MS) {
    await sleep(POLL_MS)
    let db
    try { db = new Database(dbPath, { readonly: true }) } catch { continue }

    try {
      const workers = db.prepare('SELECT id, name, role, model, agent_state FROM workers WHERE room_id = ? ORDER BY id ASC').all(room.id)
      const cycles = db.prepare(
        `SELECT id, worker_id, status, model, duration_ms, input_tokens, output_tokens, error_message
         FROM worker_cycles
         WHERE room_id = ?
         ORDER BY id ASC`
      ).all(room.id)
      const workerNameById = new Map(workers.map((w) => [w.id, w.name]))

      for (const cycle of cycles) {
        if (!seenCycleStarts.has(cycle.id)) {
          seenCycleStarts.add(cycle.id)
          const who = workerNameById.get(cycle.worker_id) || `worker#${cycle.worker_id}`
          log('CYCLE', C.cyan + C.bold, `Cycle #${cycle.id} started (${who}, model=${cycle.model || 'null'})`)
        }

        const prev = lastLogSeq.get(cycle.id) || 0
        const logs = db.prepare(
          'SELECT seq, entry_type, content FROM cycle_logs WHERE cycle_id = ? AND seq > ? ORDER BY seq ASC'
        ).all(cycle.id, prev)
        for (const entry of logs) {
          lastLogSeq.set(cycle.id, entry.seq)
          const content = String(entry.content || '').replace(/\n/g, ' ').slice(0, 220)
          if (entry.entry_type === 'tool_call') log('TOOL', C.magenta, content)
          else if (entry.entry_type === 'error') log('ERR', C.red, content)
          else if (entry.entry_type === 'assistant_text') log('TEXT', C.white, content)
          else log('LOG', C.dim, `[${entry.entry_type}] ${content}`)
        }

        if ((cycle.status === 'completed' || cycle.status === 'failed') && !seenCycleEnds.has(cycle.id)) {
          seenCycleEnds.add(cycle.id)
          const who = workerNameById.get(cycle.worker_id) || `worker#${cycle.worker_id}`
          if (cycle.status === 'completed') {
            const dur = ((cycle.duration_ms || 0) / 1000).toFixed(1)
            log('CYCLE', C.green + C.bold, `Cycle #${cycle.id} completed (${who}) in ${dur}s`)
          } else {
            log('CYCLE', C.red + C.bold, `Cycle #${cycle.id} failed (${who}): ${(cycle.error_message || '').slice(0, 200)}`)
          }
        }
      }

      const queenDone = cycles.filter((c) => c.worker_id === queen.id && (c.status === 'completed' || c.status === 'failed')).length
      const nonQueenWorkers = workers.filter((w) => w.id !== queen.id)

      if (!phase2Enabled && queenDone >= 1 && nonQueenWorkers.length > 0) {
        bootstrapWorkerId = nonQueenWorkers[0].id
        const names = nonQueenWorkers.map((w) => `${w.name}#${w.id}`).join(', ')
        log('PHASE', C.yellow + C.bold, `Phase 1 complete: auto-bootstrap detected (${names})`)

        for (const w of nonQueenWorkers) {
          await api('PATCH', `/api/workers/${w.id}`, {
            model: 'codex',
            systemPrompt: EXECUTOR_SYSTEM_PROMPT,
          }, token)
        }

        await api('PATCH', `/api/rooms/${room.id}`, { allowedTools: PHASE2_TOOLS }, token)
        await api('POST', `/api/workers/${queen.id}/start`, {}, token)
        phase2Enabled = true
        log('PHASE', C.yellow + C.bold, 'Phase 2 enabled: delegation and execution tools unlocked.')

        legacyVoting = await runLegacyVotingCheck(token, room.id, bootstrapWorkerId)
        const votingColor = legacyVoting.passed ? C.green : C.red
        log('VOTE', votingColor, `Legacy vote path check: ${legacyVoting.passed ? 'PASS' : `FAIL (${legacyVoting.reason})`}`)
      }

      if (!stopSent && queenDone >= numCycles) {
        stopSent = true
        log('RUN', C.bold, `Queen cycle cap reached (${queenDone}/${numCycles}) -> stopping room.`)
        api('POST', `/api/rooms/${room.id}/stop`, {}, token).catch(() => {})
      }

      const runningCycles = cycles.filter((c) => c.status === 'running').length
      if (stopSent && runningCycles === 0) {
        await sleep(1200)
        break
      }
    } finally {
      db.close()
    }
  }

  const db = new Database(dbPath, { readonly: true })
  const workers = db.prepare('SELECT id, name, role, model, agent_state, wip FROM workers WHERE room_id = ? ORDER BY id ASC').all(room.id)
  const cycles = db.prepare(
    `SELECT id, worker_id, status, model, duration_ms, input_tokens, output_tokens
     FROM worker_cycles
     WHERE room_id = ?
     ORDER BY id ASC`
  ).all(room.id)

  const queenCycleCount = cycles.filter((c) => c.worker_id === queen.id).length
  const queenDoneCount = cycles.filter((c) => c.worker_id === queen.id && (c.status === 'completed' || c.status === 'failed')).length
  const workerDoneCount = cycles.filter((c) => c.worker_id !== queen.id && (c.status === 'completed' || c.status === 'failed')).length

  const allToolCalls = db.prepare(
    `SELECT wc.worker_id as workerId, cl.content as content
     FROM cycle_logs cl
     JOIN worker_cycles wc ON wc.id = cl.cycle_id
     WHERE wc.room_id = ?
       AND cl.entry_type = 'tool_call'`
  ).all(room.id)

  const executionToolNames = new Set([
    'quoroom_web_search',
    'quoroom_web_fetch',
    'quoroom_browser',
    'WebSearch',
    'WebFetch',
    'Browser',
  ])

  let queenDelegations = 0
  let queenPokes = 0
  let queenExecCalls = 0
  let workerExecCalls = 0

  for (const row of allToolCalls) {
    const toolName = parseToolName(String(row.content || ''))
    if (!toolName) continue
    if (row.workerId === queen.id) {
      if (toolName === 'quoroom_delegate_task') queenDelegations++
      if (toolName === 'quoroom_send_message') queenPokes++
      if (executionToolNames.has(toolName)) queenExecCalls++
    } else if (executionToolNames.has(toolName)) {
      workerExecCalls++
    }
  }

  const deviationCount = db.prepare(
    `SELECT COUNT(*) as cnt
     FROM room_activity
     WHERE room_id = ?
       AND summary LIKE 'Queen policy deviation:%'`
  ).get(room.id).cnt

  const nonCodexWorkerCycles = db.prepare(
    `SELECT wc.id, wc.worker_id, wc.model
     FROM worker_cycles wc
     WHERE wc.room_id = ?
       AND wc.worker_id != ?
       AND (wc.model IS NULL OR wc.model NOT LIKE 'codex%')`
  ).all(room.id, queen.id)

  const autoWorkerCreated = workers.some((w) => w.id !== queen.id)
  const allWorkersCodex = workers.filter((w) => w.id !== queen.id).every((w) => String(w.model || '').startsWith('codex'))
  const telemetryConsistent = queenExecCalls === 0 || deviationCount > 0

  const checks = [
    [autoWorkerCreated, 'Auto-bootstrap created at least one non-queen worker'],
    [phase2Enabled, 'Phase 2 transition enabled (delegation unlocked)'],
    [queenDelegations > 0, 'Queen delegated tasks to worker(s)'],
    [queenPokes > 0, 'Queen poked worker(s) via message'],
    [workerDoneCount > 0, 'Worker completed at least one cycle'],
    [allWorkersCodex, 'All non-queen workers configured to codex'],
    [nonCodexWorkerCycles.length === 0, 'No non-codex worker cycles executed'],
    [legacyVoting.passed, 'Legacy voting path still records worker votes'],
    [telemetryConsistent, 'Soft deviation telemetry remained consistent'],
    [queenDoneCount <= numCycles, `Queen completed <= ${numCycles} cycles (hard cap respected)`],
  ]

  console.log('')
  console.log('═'.repeat(92))
  console.log(`${C.bold}  MODEL B CODEX EXPERIMENT RESULTS${C.reset}`)
  console.log('═'.repeat(92))
  console.log(`  Room: #${room.id}`)
  console.log(`  Queen: #${queen.id} (model=codex)`)
  console.log(`  Queen cycles: total=${queenCycleCount}, done=${queenDoneCount}, cap=${numCycles}`)
  console.log(`  Worker cycles done: ${workerDoneCount}`)
  console.log(`  Delegations: ${queenDelegations}, Pokes: ${queenPokes}, Worker execution calls: ${workerExecCalls}`)
  console.log(`  Queen execution calls: ${queenExecCalls}, Policy deviations logged: ${deviationCount}`)
  console.log(`  Legacy voting check: ${legacyVoting.passed ? `PASS (decision #${legacyVoting.decisionId})` : `FAIL (${legacyVoting.reason})`}`)
  if (nonCodexWorkerCycles.length > 0) {
    console.log(`  Non-codex worker cycles: ${nonCodexWorkerCycles.map((c) => `#${c.id}:${c.model || 'null'}`).join(', ')}`)
  }
  console.log('')

  let passCount = 0
  for (const [ok, label] of checks) {
    if (ok) passCount++
    console.log(`  ${ok ? `${C.green}✓ PASS` : `${C.red}✗ FAIL`}${C.reset}  ${label}`)
  }
  if (workerExecCalls === 0) {
    console.log(`  ${C.yellow}! INFO${C.reset}  Worker completed cycles without explicit web execution tool calls in logs.`)
  }

  console.log('')
  if (passCount === checks.length) {
    console.log(`  ${C.green}${C.bold}ALL CHECKS PASSED${C.reset}`)
  } else {
    console.log(`  ${C.yellow}${C.bold}${passCount}/${checks.length} checks passed${C.reset}`)
  }
  console.log('═'.repeat(92))
  console.log('')

  db.close()
}

function cleanup() {
  restoreCodexConfig()
  stopServer()
  if (!keepDb && dataDir && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
    log('CLEANUP', C.dim, 'Temporary DB removed.')
  } else if (keepDb && dbPath) {
    log('CLEANUP', C.green, `DB preserved at ${dbPath}`)
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
