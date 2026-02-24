#!/usr/bin/env node

const { existsSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')
const { createHash } = require('crypto')
const Database = require('better-sqlite3')

const PREFIX = 'STYLE_DEMO'
const ISOLATED_DIR_NAME = '.quoroom-dev'

function expandTilde(p) {
  if (p === '~' || p.startsWith('~/')) return p.replace('~', homedir())
  return p
}

function normalizePath(p) {
  return expandTilde(p).replace(/\\/g, '/')
}

function isIsolatedPath(p) {
  const normalized = normalizePath(p).toLowerCase()
  const isolatedToken = `/${ISOLATED_DIR_NAME.toLowerCase()}`
  return normalized.includes(`${isolatedToken}/`) || normalized.endsWith(isolatedToken)
}

function resolveDbPath() {
  if (process.env.QUOROOM_DB_PATH) return normalizePath(process.env.QUOROOM_DB_PATH)
  const dataDir = normalizePath(process.env.QUOROOM_DATA_DIR || join(homedir(), ISOLATED_DIR_NAME))
  return join(dataDir, 'data.db')
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function createSeedVectorBlob(text, dimensions = 384) {
  const vec = new Float32Array(dimensions)
  const normalized = String(text || '').toLowerCase()
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i)
    const idx = (code + i * 17) % dimensions
    vec[idx] += ((code % 31) + 1) / 31
  }

  let norm = 0
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm

  return Buffer.from(vec.buffer)
}

const dbPath = resolveDbPath()
if (!isIsolatedPath(dbPath)) {
  console.error(`Refusing to seed non-isolated DB: ${dbPath}`)
  console.error(`Set QUOROOM_DATA_DIR to a path under ~/${ISOLATED_DIR_NAME} (or use npm run seed:style-demo).`)
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`)
  console.error('Start isolated dev once (`npm run dev` or `npm run dev:room:isolated`) so migrations create the DB, then run this script again.')
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

const roomCols = db.pragma('table_info(rooms)')
if (!roomCols.some((c) => c.name === 'referred_by_code')) {
  db.exec('ALTER TABLE rooms ADD COLUMN referred_by_code TEXT')
}

db.transaction(() => {
  const nowIso = new Date().toISOString()

  // Ensure advanced UI is visible for style checking.
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('advanced_mode', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(nowIso)
  const keeperReferralCode = 'styledemo-keeper'
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('keeper_referral_code', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(keeperReferralCode, nowIso)

  // Clean up previous style-demo rooms and their non-cascading children.
  const existingRooms = db.prepare('SELECT id FROM rooms WHERE name LIKE ?').all(`${PREFIX} %`)
  for (const row of existingRooms) {
    const roomId = row.id
    db.prepare('DELETE FROM console_logs WHERE run_id IN (SELECT id FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?))').run(roomId)
    db.prepare('DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?)').run(roomId)
    db.prepare('DELETE FROM tasks WHERE room_id = ?').run(roomId)
    db.prepare('DELETE FROM watches WHERE room_id = ?').run(roomId)
    db.prepare('DELETE FROM workers WHERE room_id = ?').run(roomId)
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
  }

  // Extra cleanup for any stray rows from older seed formats.
  db.prepare("DELETE FROM console_logs WHERE run_id IN (SELECT id FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE name LIKE ?))").run(`${PREFIX} %`)
  db.prepare('DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE name LIKE ?)').run(`${PREFIX} %`)
  db.prepare('DELETE FROM tasks WHERE name LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM goal_updates WHERE goal_id IN (SELECT id FROM goals WHERE description LIKE ?)').run(`${PREFIX} %`)
  db.prepare('DELETE FROM goals WHERE description LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM quorum_votes WHERE decision_id IN (SELECT id FROM quorum_decisions WHERE proposal LIKE ?)').run(`${PREFIX} %`)
  db.prepare('DELETE FROM quorum_decisions WHERE proposal LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM skills WHERE name LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM credentials WHERE name LIKE ?').run(`${PREFIX}%`)
  db.prepare('DELETE FROM entities WHERE name LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM escalations WHERE question LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM room_messages WHERE subject LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM wallet_transactions WHERE description LIKE ? OR counterparty LIKE ?').run(`${PREFIX} %`, `${PREFIX} %`)
  db.prepare('DELETE FROM room_activity WHERE summary LIKE ? OR details LIKE ?').run(`${PREFIX} %`, `${PREFIX} %`)
  db.prepare('DELETE FROM chat_messages WHERE content LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM watches WHERE path LIKE ?').run('/tmp/style-demo/%')
  db.prepare('DELETE FROM self_mod_audit WHERE file_path LIKE ? OR reason LIKE ?').run('/style-demo/%', `${PREFIX} %`)
  db.prepare('DELETE FROM stations WHERE name LIKE ?').run(`${PREFIX} %`)
  db.prepare('DELETE FROM workers WHERE name LIKE ?').run(`${PREFIX} %`)

  // Rooms -----------------------------------------------------------------
  const insertRoom = db.prepare(`
    INSERT INTO rooms
      (name, goal, status, visibility, autonomy_mode, max_concurrent_tasks, worker_model,
       queen_cycle_gap_ms, queen_max_turns, created_at, updated_at, referred_by_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const roomMainId = Number(insertRoom.run(
    `${PREFIX} Room Alpha`,
    `${PREFIX} Ship AI products with positive margin`,
    'active',
    'private',
    'semi',
    4,
    'claude',
    900000,
    5,
    isoMinutesAgo(2),
    isoMinutesAgo(1),
    null
  ).lastInsertRowid)

  const roomBetaId = Number(insertRoom.run(
    `${PREFIX} Room Beta`,
    `${PREFIX} Growth experiments and content engine`,
    'active',
    'private',
    'auto',
    3,
    'codex',
    1800000,
    3,
    isoMinutesAgo(20),
    isoMinutesAgo(12),
    null
  ).lastInsertRowid)

  const roomGammaId = Number(insertRoom.run(
    `${PREFIX} Room Gamma`,
    `${PREFIX} Ops and treasury controls`,
    'paused',
    'private',
    'semi',
    2,
    'claude',
    3600000,
    2,
    isoMinutesAgo(40),
    isoMinutesAgo(30),
    null
  ).lastInsertRowid)

  // Invite-linked rooms for Swarm network previews.
  // Keep them stopped so they render as referred rooms, not primary rooms.
  const inviteVariants = [
    // Alpha referrals (7)
    { code: keeperReferralCode, name: 'Alpha North', goal: 'Partner room for alpha expansion', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 90, updatedAgo: 74 },
    { code: keeperReferralCode, name: 'Alpha Labs', goal: 'R&D room testing alpha pricing variants', visibility: 'private', mode: 'semi', model: 'codex', gapMs: 1800000, maxTurns: 2, createdAgo: 89, updatedAgo: 73 },
    { code: keeperReferralCode, name: 'Alpha West', goal: 'Regional room validating west-coast lead quality', visibility: 'private', mode: 'auto', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 88, updatedAgo: 72 },
    { code: keeperReferralCode, name: 'Alpha East', goal: 'Regional room running outbound partner tests', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 87, updatedAgo: 71 },
    { code: keeperReferralCode, name: 'Alpha Ops', goal: 'Operations room monitoring onboarding bottlenecks', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 86, updatedAgo: 70 },
    { code: keeperReferralCode, name: 'Alpha Content', goal: 'Content room producing conversion-first docs', visibility: 'private', mode: 'auto', model: 'codex', gapMs: 1800000, maxTurns: 2, createdAgo: 85, updatedAgo: 69 },
    { code: keeperReferralCode, name: 'Alpha Edge', goal: 'Experiment room validating edge ICP opportunities', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 84, updatedAgo: 68 },

    // Beta referrals (7)
    { code: keeperReferralCode, name: 'Beta Loop', goal: 'Referred growth room running paid loops', visibility: 'private', mode: 'auto', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 83, updatedAgo: 67 },
    { code: keeperReferralCode, name: 'Beta Relay', goal: 'Referred partner room relaying campaign insights', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 82, updatedAgo: 66 },
    { code: keeperReferralCode, name: 'Beta Studio', goal: 'Creative studio room testing ad variants', visibility: 'private', mode: 'semi', model: 'codex', gapMs: 1800000, maxTurns: 2, createdAgo: 81, updatedAgo: 65 },
    { code: keeperReferralCode, name: 'Beta Search', goal: 'SEO room scaling long-tail acquisition', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 80, updatedAgo: 64 },
    { code: keeperReferralCode, name: 'Beta Pulse', goal: 'Analytics room tracking channel pulse weekly', visibility: 'private', mode: 'auto', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 79, updatedAgo: 63 },
    { code: keeperReferralCode, name: 'Beta Partner', goal: 'Partner success room coordinating joint launches', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 1800000, maxTurns: 2, createdAgo: 78, updatedAgo: 62 },
    { code: keeperReferralCode, name: 'Beta Sprint', goal: 'Sprint room shipping rapid messaging iterations', visibility: 'private', mode: 'semi', model: 'codex', gapMs: 1800000, maxTurns: 2, createdAgo: 77, updatedAgo: 61 },

    // Gamma referrals (6)
    { code: keeperReferralCode, name: 'Gamma Vault', goal: 'Referred treasury room focused on risk controls', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 3600000, maxTurns: 2, createdAgo: 76, updatedAgo: 60 },
    { code: keeperReferralCode, name: 'Gamma Risk', goal: 'Risk room monitoring counterparty exposure', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 3600000, maxTurns: 2, createdAgo: 75, updatedAgo: 59 },
    { code: keeperReferralCode, name: 'Gamma Ledger', goal: 'Ledger room reconciling inflow/outflow anomalies', visibility: 'private', mode: 'semi', model: 'codex', gapMs: 3600000, maxTurns: 2, createdAgo: 74, updatedAgo: 58 },
    { code: keeperReferralCode, name: 'Gamma Guard', goal: 'Control room validating treasury policy changes', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 3600000, maxTurns: 2, createdAgo: 73, updatedAgo: 57 },
    { code: keeperReferralCode, name: 'Gamma Reserve', goal: 'Reserve room stress-testing downside scenarios', visibility: 'private', mode: 'semi', model: 'claude', gapMs: 3600000, maxTurns: 2, createdAgo: 72, updatedAgo: 56 },
    { code: keeperReferralCode, name: 'Gamma Audit', goal: 'Audit room reviewing wallet integrity checkpoints', visibility: 'private', mode: 'semi', model: 'codex', gapMs: 3600000, maxTurns: 2, createdAgo: 71, updatedAgo: 55 },
  ]

  for (const entry of inviteVariants) {
    insertRoom.run(
      `${PREFIX} Invite ${entry.name}`,
      `${PREFIX} ${entry.goal}`,
      'stopped',
      entry.visibility,
      entry.mode,
      2,
      entry.model,
      entry.gapMs,
      entry.maxTurns,
      isoMinutesAgo(entry.createdAgo),
      isoMinutesAgo(entry.updatedAgo),
      entry.code
    )
  }

  // Workers ---------------------------------------------------------------
  const insertWorker = db.prepare(`
    INSERT INTO workers
      (name, role, system_prompt, description, model, is_default, task_count, room_id, agent_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const queenId = Number(insertWorker.run(
    `${PREFIX} Queen`,
    'Coordinator',
    'Coordinate workers, escalate blockers, optimize for net profit.',
    'Orchestrates room decisions and daily plans',
    'claude',
    0,
    2,
    roomMainId,
    'thinking',
    isoMinutesAgo(70),
    isoMinutesAgo(1)
  ).lastInsertRowid)

  const scoutId = Number(insertWorker.run(
    `${PREFIX} Scout`,
    'Researcher',
    'Find monetizable opportunities quickly using primary sources.',
    'Opportunity and market researcher',
    'claude',
    0,
    2,
    roomMainId,
    'idle',
    isoMinutesAgo(69),
    isoMinutesAgo(8)
  ).lastInsertRowid)

  const forgeId = Number(insertWorker.run(
    `${PREFIX} Forge`,
    'Builder',
    'Ship MVPs fast, measure outcomes, avoid overengineering.',
    'Builds landing pages, automations, and APIs',
    'codex',
    1,
    3,
    roomMainId,
    'acting',
    isoMinutesAgo(68),
    isoMinutesAgo(3)
  ).lastInsertRowid)

  const blazeId = Number(insertWorker.run(
    `${PREFIX} Blaze`,
    'Marketer',
    'Test channels, optimize for paid conversions.',
    'Runs growth experiments and campaigns',
    'claude',
    0,
    1,
    roomMainId,
    'idle',
    isoMinutesAgo(67),
    isoMinutesAgo(14)
  ).lastInsertRowid)

  const ledgerId = Number(insertWorker.run(
    `${PREFIX} Ledger`,
    'Analyst',
    'Track margin, burn, and unit economics.',
    'Audits wallet flows and ROI',
    'codex',
    0,
    2,
    roomMainId,
    'idle',
    isoMinutesAgo(66),
    isoMinutesAgo(18)
  ).lastInsertRowid)

  const betaWorkerId = Number(insertWorker.run(
    `${PREFIX} Beta Worker`,
    'Operator',
    'Keep growth room moving with simple experiments.',
    'Supports beta room execution',
    'claude',
    0,
    1,
    roomBetaId,
    'idle',
    isoMinutesAgo(30),
    isoMinutesAgo(12)
  ).lastInsertRowid)

  const gammaWorkerId = Number(insertWorker.run(
    `${PREFIX} Gamma Worker`,
    'Ops',
    'Maintain infrastructure and risk controls.',
    'Supports treasury room operations',
    'claude',
    0,
    1,
    roomGammaId,
    'idle',
    isoMinutesAgo(45),
    isoMinutesAgo(30)
  ).lastInsertRowid)

  db.prepare('UPDATE rooms SET queen_worker_id = ?, updated_at = ? WHERE id = ?').run(queenId, nowIso, roomMainId)
  db.prepare('UPDATE rooms SET queen_worker_id = ?, updated_at = ? WHERE id = ?').run(betaWorkerId, nowIso, roomBetaId)
  db.prepare('UPDATE rooms SET queen_worker_id = ?, updated_at = ? WHERE id = ?').run(gammaWorkerId, nowIso, roomGammaId)

  // Wallets + transactions ------------------------------------------------
  const insertWallet = db.prepare(`
    INSERT INTO wallets (room_id, address, private_key_encrypted, chain, erc8004_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const walletMainId = Number(insertWallet.run(
    roomMainId,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'enc:v1:style_demo_wallet_alpha',
    'base',
    'agent-style-alpha',
    isoMinutesAgo(60)
  ).lastInsertRowid)

  const walletBetaId = Number(insertWallet.run(
    roomBetaId,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'enc:v1:style_demo_wallet_beta',
    'base',
    'agent-style-beta',
    isoMinutesAgo(35)
  ).lastInsertRowid)

  const insertWalletTx = db.prepare(`
    INSERT INTO wallet_transactions (wallet_id, type, amount, counterparty, tx_hash, description, status, category, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertWalletTx.run(walletMainId, 'fund', '250.00', 'STYLE_DEMO Treasury', '0xtxstylefund01', `${PREFIX} Initial funding`, 'confirmed', null, isoMinutesAgo(59))
  insertWalletTx.run(walletMainId, 'receive', '47.50', 'STYLE_DEMO Customer A', '0xtxstylerecv01', `${PREFIX} Subscription payment`, 'confirmed', 'revenue', isoMinutesAgo(38))
  insertWalletTx.run(walletMainId, 'purchase', '15.00', 'STYLE_DEMO Cloud', '0xtxstylebuy01', `${PREFIX} Station monthly fee`, 'confirmed', 'station_cost', isoMinutesAgo(28))
  insertWalletTx.run(walletMainId, 'send', '22.00', 'STYLE_DEMO Vendor', '0xtxstylesend01', `${PREFIX} Contractor payout`, 'confirmed', 'ops', isoMinutesAgo(16))
  insertWalletTx.run(walletMainId, 'receive', '89.00', 'STYLE_DEMO Customer B', '0xtxstylerecv02', `${PREFIX} One-time purchase`, 'confirmed', 'revenue', isoMinutesAgo(9))

  insertWalletTx.run(walletBetaId, 'fund', '75.00', 'STYLE_DEMO Treasury', '0xtxstylefund02', `${PREFIX} Beta top-up`, 'confirmed', null, isoMinutesAgo(32))
  insertWalletTx.run(walletBetaId, 'purchase', '9.00', 'STYLE_DEMO Cloud', '0xtxstylebuy02', `${PREFIX} Micro station fee`, 'confirmed', 'station_cost', isoMinutesAgo(22))

  // Stations (local DB, used by swarm/status) ----------------------------
  const insertStation = db.prepare(`
    INSERT INTO stations (room_id, name, provider, external_id, tier, region, status, monthly_cost, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertStation.run(roomMainId, `${PREFIX} core-grid`, 'fly', 'fly-style-001', 'small', 'iad', 'active', 25, '{"cpu":2,"memory":"512mb"}', isoMinutesAgo(26), isoMinutesAgo(5))
  insertStation.run(roomMainId, `${PREFIX} relay-node`, 'fly', 'fly-style-002', 'small', 'ams', 'stopped', 25, '{"cpu":2,"memory":"512mb"}', isoMinutesAgo(24), isoMinutesAgo(12))
  insertStation.run(roomMainId, `${PREFIX} edge-ops`, 'fly', 'fly-style-003', 'micro', 'sjc', 'error', 9, '{"cpu":1,"memory":"256mb"}', isoMinutesAgo(21), isoMinutesAgo(7))
  insertStation.run(roomBetaId, `${PREFIX} beta-micro`, 'fly', 'fly-style-004', 'micro', 'fra', 'active', 9, '{"cpu":1,"memory":"256mb"}', isoMinutesAgo(19), isoMinutesAgo(10))

  // Tasks + runs + console logs ------------------------------------------
  const insertTask = db.prepare(`
    INSERT INTO tasks
      (name, description, prompt, cron_expression, trigger_type, trigger_config, executor, status, last_run, last_result,
       error_count, scheduled_at, max_runs, run_count, memory_entity_id, worker_id, session_continuity, session_id,
       timeout_minutes, max_turns, allowed_tools, disallowed_tools, learned_context, room_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const taskMarketId = Number(insertTask.run(
    `${PREFIX} Market Scan`,
    'Scan new SaaS pricing changes and identify opportunities.',
    'Collect pricing deltas, summarize and recommend next move.',
    '*/30 * * * *',
    'cron',
    '{"timezone":"UTC"}',
    'claude_code',
    'active',
    isoMinutesAgo(6),
    'Found 2 potential competitor pricing shifts.',
    0,
    isoMinutesAgo(24),
    null,
    8,
    null,
    scoutId,
    1,
    'sess-style-market',
    20,
    8,
    'search,fetch,write',
    null,
    'Prefer official pricing pages',
    roomMainId,
    isoMinutesAgo(55),
    isoMinutesAgo(6)
  ).lastInsertRowid)

  const taskLandingId = Number(insertTask.run(
    `${PREFIX} Build Landing`,
    'Ship landing page for alpha offer.',
    'Implement copy, CTA, analytics and publish.',
    null,
    'manual',
    null,
    'codex',
    'paused',
    isoMinutesAgo(65),
    'Waiting for final copy updates.',
    1,
    null,
    null,
    3,
    null,
    forgeId,
    0,
    null,
    30,
    6,
    null,
    null,
    null,
    roomMainId,
    isoMinutesAgo(64),
    isoMinutesAgo(15)
  ).lastInsertRowid)

  const taskCampaignId = Number(insertTask.run(
    `${PREFIX} Campaign Sweep`,
    'Evaluate campaign CTR and CPA by channel.',
    'Summarize top and bottom channels and next experiments.',
    '15 * * * *',
    'cron',
    '{"timezone":"UTC"}',
    'claude_code',
    'completed',
    isoMinutesAgo(14),
    'Paused low-performing adset and reallocated budget.',
    0,
    isoMinutesAgo(14),
    20,
    20,
    null,
    blazeId,
    0,
    null,
    15,
    5,
    null,
    null,
    null,
    roomMainId,
    isoMinutesAgo(80),
    isoMinutesAgo(14)
  ).lastInsertRowid)

  const taskAuditId = Number(insertTask.run(
    `${PREFIX} Expense Audit`,
    'Audit weekly spend anomalies.',
    'List unusual spend and estimate impact on runway.',
    null,
    'event',
    '{"event":"wallet:sent"}',
    'codex',
    'active',
    isoMinutesAgo(3),
    'Flagged one unusual transfer for review.',
    0,
    null,
    null,
    12,
    null,
    ledgerId,
    1,
    'sess-style-audit',
    25,
    6,
    null,
    null,
    'Compare against 7-day baseline',
    roomMainId,
    isoMinutesAgo(50),
    isoMinutesAgo(3)
  ).lastInsertRowid)

  const insertRun = db.prepare(`
    INSERT INTO task_runs (task_id, started_at, finished_at, status, result, result_file, error_message, duration_ms, progress, progress_message, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const runMarketId = Number(insertRun.run(taskMarketId, isoMinutesAgo(5), null, 'running', null, null, null, null, 0.62, 'Comparing 9 competitors', 'sess-style-market').lastInsertRowid)
  const runCampaignId = Number(insertRun.run(taskCampaignId, isoMinutesAgo(14), isoMinutesAgo(13), 'completed', 'Shifted spend to top 2 channels; projected +18% ROAS.', null, null, 48210, 1.0, 'Done', 'sess-style-campaign').lastInsertRowid)
  const runAuditId = Number(insertRun.run(taskAuditId, isoMinutesAgo(4), isoMinutesAgo(3), 'failed', null, null, 'API quota hit while pulling card statements.', 11870, 1.0, 'Failed on provider call', 'sess-style-audit').lastInsertRowid)

  const insertLog = db.prepare('INSERT INTO console_logs (run_id, seq, entry_type, content, created_at) VALUES (?, ?, ?, ?, ?)')
  insertLog.run(runMarketId, 1, 'assistant_text', 'Starting competitor scan across tracked segments.', isoMinutesAgo(5))
  insertLog.run(runMarketId, 2, 'tool_call', 'search_query: "SaaS pricing change January"', isoMinutesAgo(4))
  insertLog.run(runMarketId, 3, 'tool_result', '8 relevant pricing pages fetched.', isoMinutesAgo(4))
  insertLog.run(runMarketId, 4, 'assistant_text', 'Drafting summary and confidence score.', isoMinutesAgo(3))

  insertLog.run(runCampaignId, 1, 'assistant_text', 'Loading campaign analytics snapshot.', isoMinutesAgo(14))
  insertLog.run(runCampaignId, 2, 'result', 'High CPA on TikTok; paused adset 3.', isoMinutesAgo(13))

  insertLog.run(runAuditId, 1, 'assistant_text', 'Requesting card statement export.', isoMinutesAgo(4))
  insertLog.run(runAuditId, 2, 'error', '429 Too Many Requests from provider API.', isoMinutesAgo(3))

  // Watches ---------------------------------------------------------------
  const insertWatch = db.prepare(
    'INSERT INTO watches (path, description, action_prompt, status, last_triggered, trigger_count, room_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  insertWatch.run('/tmp/style-demo/invoices', 'Track new invoices', 'Summarize invoice amount and vendor', 'active', isoMinutesAgo(11), 6, roomMainId, isoMinutesAgo(58))
  insertWatch.run('/tmp/style-demo/competitors', 'Watch competitor launch notes', 'Extract notable positioning changes', 'paused', isoMinutesAgo(90), 2, roomMainId, isoMinutesAgo(57))
  insertWatch.run('/tmp/style-demo/deployments', 'Track deployment events', 'Alert on failures and rollbacks', 'active', isoMinutesAgo(6), 12, roomMainId, isoMinutesAgo(56))

  // Goals + updates -------------------------------------------------------
  const insertGoal = db.prepare(
    'INSERT INTO goals (room_id, description, status, parent_goal_id, assigned_worker_id, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const goalTopId = Number(insertGoal.run(roomMainId, `${PREFIX} Reach $1,000 MRR`, 'in_progress', null, queenId, 0.58, isoMinutesAgo(100), isoMinutesAgo(4)).lastInsertRowid)
  const goalChild1Id = Number(insertGoal.run(roomMainId, `${PREFIX} Launch paid landing page`, 'completed', goalTopId, forgeId, 1.0, isoMinutesAgo(95), isoMinutesAgo(16)).lastInsertRowid)
  const goalChild2Id = Number(insertGoal.run(roomMainId, `${PREFIX} Reduce CPA under $20`, 'blocked', goalTopId, blazeId, 0.35, isoMinutesAgo(93), isoMinutesAgo(7)).lastInsertRowid)
  const goalOpsId = Number(insertGoal.run(roomMainId, `${PREFIX} Build weekly finance dashboard`, 'active', null, ledgerId, 0.42, isoMinutesAgo(92), isoMinutesAgo(5)).lastInsertRowid)

  const insertGoalUpdate = db.prepare('INSERT INTO goal_updates (goal_id, worker_id, observation, metric_value, created_at) VALUES (?, ?, ?, ?, ?)')
  insertGoalUpdate.run(goalTopId, queenId, 'Pipeline quality improved after narrowing segment focus.', 0.58, isoMinutesAgo(4))
  insertGoalUpdate.run(goalChild1Id, forgeId, 'Page published with checkout and analytics.', 1.0, isoMinutesAgo(16))
  insertGoalUpdate.run(goalChild2Id, blazeId, 'CPA still elevated on one channel.', 0.35, isoMinutesAgo(7))
  insertGoalUpdate.run(goalOpsId, ledgerId, 'Draft dashboard connected to wallet feed.', 0.42, isoMinutesAgo(5))

  // Skills ----------------------------------------------------------------
  const insertSkill = db.prepare(
    'INSERT INTO skills (room_id, name, content, activation_context, auto_activate, agent_created, created_by_worker_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  insertSkill.run(roomMainId, `${PREFIX} Pricing Diff Scanner`, 'Compare historical and current pricing pages and report meaningful deltas.', JSON.stringify(['research', 'pricing', 'competition']), 1, 1, scoutId, 3, isoMinutesAgo(88), isoMinutesAgo(6))
  insertSkill.run(roomMainId, `${PREFIX} Landing QA Checklist`, 'Run conversion-focused QA before publishing any landing page.', JSON.stringify(['deploy', 'marketing']), 0, 0, forgeId, 2, isoMinutesAgo(84), isoMinutesAgo(10))
  insertSkill.run(roomMainId, `${PREFIX} Spend Anomaly Detector`, 'Flag unusual spend against 7-day moving baseline.', JSON.stringify(['finance', 'wallet']), 1, 1, ledgerId, 5, isoMinutesAgo(82), isoMinutesAgo(3))

  // Credentials -----------------------------------------------------------
  const insertCred = db.prepare(
    'INSERT INTO credentials (room_id, name, type, value_encrypted, provided_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  insertCred.run(roomMainId, 'OPENAI_API_KEY', 'api_key', 'enc:v1:style_openai_key', 'keeper', isoMinutesAgo(80))
  insertCred.run(roomMainId, 'ANTHROPIC_API_KEY', 'api_key', 'enc:v1:style_anthropic_key', 'keeper', isoMinutesAgo(79))
  insertCred.run(roomMainId, 'STRIPE_SECRET_KEY', 'api_key', 'enc:v1:style_stripe_key', 'keeper', isoMinutesAgo(78))

  // Memory entities -------------------------------------------------------
  const insertEntity = db.prepare(
    'INSERT INTO entities (name, type, category, room_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const insertEmbedding = db.prepare(`
    INSERT INTO embeddings (entity_id, source_type, source_id, text_hash, vector, model, dimensions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_type, source_id, model) DO UPDATE SET
      text_hash = excluded.text_hash,
      vector = excluded.vector,
      dimensions = excluded.dimensions
  `)
  const markEntityEmbedded = db.prepare('UPDATE entities SET embedded_at = ? WHERE id = ?')

  function seedEntityEmbedding(entityId, content, createdAt) {
    const model = 'all-MiniLM-L6-v2'
    const dimensions = 384
    const textHash = hashText(content)
    const vector = createSeedVectorBlob(content, dimensions)
    insertEmbedding.run(entityId, 'entity', entityId, textHash, vector, model, dimensions, createdAt)
    markEntityEmbedded.run(createdAt, entityId)
  }

  const entityOfferId = Number(insertEntity.run(`${PREFIX} Offer: AI Audit`, 'opportunity', 'revenue', roomMainId, isoMinutesAgo(77), isoMinutesAgo(8)).lastInsertRowid)
  const entitySegmentId = Number(insertEntity.run(`${PREFIX} Segment: Indie SaaS`, 'market', 'targeting', roomMainId, isoMinutesAgo(76), isoMinutesAgo(9)).lastInsertRowid)
  const entityCompetitorId = Number(insertEntity.run(`${PREFIX} Competitor: AcmeOps`, 'company', 'competition', roomMainId, isoMinutesAgo(75), isoMinutesAgo(10)).lastInsertRowid)
  const entityChannelId = Number(insertEntity.run(`${PREFIX} Channel: X Ads`, 'channel', 'marketing', roomMainId, isoMinutesAgo(74), isoMinutesAgo(7)).lastInsertRowid)
  const entityRiskId = Number(insertEntity.run(`${PREFIX} Risk: API Quota`, 'risk', 'operations', roomMainId, isoMinutesAgo(73), isoMinutesAgo(3)).lastInsertRowid)

  const insertObs = db.prepare('INSERT INTO observations (entity_id, content, source, created_at) VALUES (?, ?, ?, ?)')
  insertObs.run(entityOfferId, 'Average deal size increased from $89 to $129 after adding onboarding template.', 'style-seed', isoMinutesAgo(8))
  insertObs.run(entitySegmentId, 'Indie SaaS cohort shows best trial-to-paid conversion this week.', 'style-seed', isoMinutesAgo(9))
  insertObs.run(entityCompetitorId, 'AcmeOps introduced annual discount and reduced trial to 7 days.', 'style-seed', isoMinutesAgo(10))
  insertObs.run(entityChannelId, 'X Ads delivered CTR 2.8% with moderate CPA drift.', 'style-seed', isoMinutesAgo(7))
  insertObs.run(entityRiskId, 'One provider started returning 429 around 18:00 UTC.', 'style-seed', isoMinutesAgo(3))

  seedEntityEmbedding(entityOfferId, `${PREFIX} Offer: AI Audit Average deal size increased from $89 to $129 after adding onboarding template.`, isoMinutesAgo(8))
  seedEntityEmbedding(entitySegmentId, `${PREFIX} Segment: Indie SaaS Indie SaaS cohort shows best trial-to-paid conversion this week.`, isoMinutesAgo(9))
  seedEntityEmbedding(entityCompetitorId, `${PREFIX} Competitor: AcmeOps AcmeOps introduced annual discount and reduced trial to 7 days.`, isoMinutesAgo(10))
  seedEntityEmbedding(entityChannelId, `${PREFIX} Channel: X Ads X Ads delivered CTR 2.8% with moderate CPA drift.`, isoMinutesAgo(7))
  seedEntityEmbedding(entityRiskId, `${PREFIX} Risk: API Quota One provider started returning 429 around 18:00 UTC.`, isoMinutesAgo(3))

  const insertRelation = db.prepare('INSERT INTO relations (from_entity, to_entity, relation_type, created_at) VALUES (?, ?, ?, ?)')
  insertRelation.run(entityOfferId, entitySegmentId, 'targets', isoMinutesAgo(8))
  insertRelation.run(entityCompetitorId, entityOfferId, 'competes_with', isoMinutesAgo(10))
  insertRelation.run(entityChannelId, entityOfferId, 'acquires_for', isoMinutesAgo(7))
  insertRelation.run(entityRiskId, entityChannelId, 'impacts', isoMinutesAgo(3))

  // Quorum decisions + votes ---------------------------------------------
  const insertDecision = db.prepare(
    'INSERT INTO quorum_decisions (room_id, proposer_id, proposal, decision_type, status, result, threshold, timeout_at, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )

  const decVotingId = Number(insertDecision.run(
    roomMainId,
    queenId,
    `${PREFIX} Shift 30% budget from X Ads to content distribution`,
    'resource',
    'voting',
    null,
    'majority',
    isoMinutesAgo(-40),
    isoMinutesAgo(12),
    null
  ).lastInsertRowid)

  const decApprovedId = Number(insertDecision.run(
    roomMainId,
    scoutId,
    `${PREFIX} Prioritize Indie SaaS segment this sprint`,
    'strategy',
    'approved',
    'Segment approved and roadmap updated',
    'majority',
    isoMinutesAgo(100),
    isoMinutesAgo(70),
    isoMinutesAgo(60)
  ).lastInsertRowid)

  const decRejectedId = Number(insertDecision.run(
    roomMainId,
    blazeId,
    `${PREFIX} Hire external growth consultant immediately`,
    'personnel',
    'rejected',
    'Rejected due to budget constraints',
    'majority',
    isoMinutesAgo(200),
    isoMinutesAgo(120),
    isoMinutesAgo(110)
  ).lastInsertRowid)

  const insertVote = db.prepare('INSERT INTO quorum_votes (decision_id, worker_id, vote, reasoning, created_at) VALUES (?, ?, ?, ?, ?)')
  insertVote.run(decVotingId, scoutId, 'yes', 'Expected better long-term CAC in content channel.', isoMinutesAgo(11))
  insertVote.run(decVotingId, forgeId, 'abstain', 'Need one more day of attribution data.', isoMinutesAgo(10))
  insertVote.run(decApprovedId, forgeId, 'yes', 'Build backlog aligns with this segment.', isoMinutesAgo(61))
  insertVote.run(decApprovedId, ledgerId, 'yes', 'Higher margin profile than alternatives.', isoMinutesAgo(60))
  insertVote.run(decRejectedId, ledgerId, 'no', 'Cost not justified by projected lift.', isoMinutesAgo(111))

  // Messages / escalations -----------------------------------------------
  const insertEsc = db.prepare(
    'INSERT INTO escalations (room_id, from_agent_id, to_agent_id, question, answer, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  insertEsc.run(roomMainId, scoutId, queenId, `${PREFIX} Need approval to scrape 3 new sources`, null, 'pending', isoMinutesAgo(6), null)
  insertEsc.run(roomMainId, forgeId, queenId, `${PREFIX} Can we defer analytics refactor until after launch?`, 'Yes, defer refactor until MRR target is stable.', 'resolved', isoMinutesAgo(25), isoMinutesAgo(22))
  insertEsc.run(roomMainId, blazeId, ledgerId, `${PREFIX} Is CPA threshold still $20 this week?`, 'Pending updated finance snapshot.', 'in_progress', isoMinutesAgo(14), null)

  const insertRoomMsg = db.prepare(
    'INSERT INTO room_messages (room_id, direction, from_room_id, to_room_id, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  insertRoomMsg.run(roomMainId, 'inbound', 'room_growth_11', null, `${PREFIX} Cross-room lead handoff`, 'We found 12 leads that fit your ICP. Sending list next.', 'unread', isoMinutesAgo(5))
  insertRoomMsg.run(roomMainId, 'outbound', null, 'room_ops_04', `${PREFIX} Need infra estimate`, 'Please estimate infra cost for 500 daily active users.', 'replied', isoMinutesAgo(18))
  insertRoomMsg.run(roomMainId, 'inbound', 'room_finance_02', null, `${PREFIX} Budget alert`, 'Monthly burn rose 12% after station upgrades.', 'read', isoMinutesAgo(33))

  // Room activity timeline -----------------------------------------------
  const insertActivity = db.prepare(
    'INSERT INTO room_activity (room_id, event_type, actor_id, summary, details, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insertActivity.run(roomMainId, 'decision', queenId, `${PREFIX} Resource proposal opened`, 'Budget reallocation vote is in progress.', 1, isoMinutesAgo(12))
  insertActivity.run(roomMainId, 'milestone', forgeId, `${PREFIX} Landing page shipped`, 'Published with checkout flow and analytics.', 1, isoMinutesAgo(16))
  insertActivity.run(roomMainId, 'financial', ledgerId, `${PREFIX} Revenue posted`, 'New payment of $89 confirmed.', 1, isoMinutesAgo(9))
  insertActivity.run(roomMainId, 'deployment', forgeId, `${PREFIX} API deployed`, 'v0.8 deployed to station core-grid.', 1, isoMinutesAgo(20))
  insertActivity.run(roomMainId, 'worker', scoutId, `${PREFIX} Research cycle complete`, 'Uploaded pricing deltas for 9 competitors.', 1, isoMinutesAgo(21))
  insertActivity.run(roomMainId, 'error', ledgerId, `${PREFIX} Provider rate limit`, '429 errors from card statement provider.', 1, isoMinutesAgo(3))
  insertActivity.run(roomMainId, 'system', null, `${PREFIX} Nightly cleanup finished`, 'Purged stale sessions and snapshots.', 1, isoMinutesAgo(30))
  insertActivity.run(roomMainId, 'self_mod', forgeId, `${PREFIX} Runtime patch applied`, 'Adjusted retry logic for webhook worker.', 1, isoMinutesAgo(4))

  // Results: self-mod audit ----------------------------------------------
  const insertAudit = db.prepare(
    'INSERT INTO self_mod_audit (room_id, worker_id, file_path, old_hash, new_hash, reason, reversible, reverted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  insertAudit.run(roomMainId, forgeId, '/style-demo/src/retry.ts', 'oldhash001', 'newhash001', `${PREFIX} Improve backoff behavior for transient failures`, 1, 0, isoMinutesAgo(4))
  insertAudit.run(roomMainId, queenId, '/style-demo/src/allocator.ts', 'oldhash002', 'newhash002', `${PREFIX} Rebalance worker assignment scoring`, 1, 1, isoMinutesAgo(35))

  // Chat ------------------------------------------------------------------
  const insertChat = db.prepare('INSERT INTO chat_messages (room_id, role, content, created_at) VALUES (?, ?, ?, ?)')
  insertChat.run(roomMainId, 'user', `${PREFIX} Give me today\'s top priorities.`, isoMinutesAgo(2))
  insertChat.run(roomMainId, 'assistant', 'Top priorities: close high-intent leads, reduce CPA on X Ads, verify provider limits.', isoMinutesAgo(1))

  // Keep room model field aligned with queen choice for UI chips.
  db.prepare('UPDATE rooms SET worker_model = ?, updated_at = ? WHERE id = ?').run('claude', nowIso, roomMainId)

  // ----------------------------------------------------------------------
  // Seed non-demo rooms too, so current user-selected rooms also show data
  // across all tabs (goals, votes, tasks, messages, memory, etc.).
  // ----------------------------------------------------------------------
  const otherRooms = db.prepare(
    'SELECT id, name, queen_worker_id FROM rooms WHERE status != ? AND name NOT LIKE ? ORDER BY updated_at DESC'
  ).all('stopped', `${PREFIX} %`)
  const getRoomWallet = db.prepare('SELECT id FROM wallets WHERE room_id = ? ORDER BY id ASC LIMIT 1')

  for (const room of otherRooms) {
    const roomId = Number(room.id)
    const roomPrefix = `${PREFIX} R${roomId}`

    const roomQueenId = Number(insertWorker.run(
      `${roomPrefix} Queen`,
      'Coordinator',
      'Coordinate workers and keep room execution aligned to revenue.',
      'Seeded coordinator for style QA',
      'claude',
      0,
      1,
      roomId,
      'thinking',
      isoMinutesAgo(30),
      isoMinutesAgo(2)
    ).lastInsertRowid)

    const roomOpsId = Number(insertWorker.run(
      `${roomPrefix} Ops`,
      'Operator',
      'Execute tasks fast, report blockers with options.',
      'Seeded operator for style QA',
      'codex',
      1,
      2,
      roomId,
      'acting',
      isoMinutesAgo(28),
      isoMinutesAgo(3)
    ).lastInsertRowid)

    const roomGrowthId = Number(insertWorker.run(
      `${roomPrefix} Growth`,
      'Marketer',
      'Run small channel experiments and optimize CPA.',
      'Seeded marketer for style QA',
      'claude',
      0,
      1,
      roomId,
      'idle',
      isoMinutesAgo(27),
      isoMinutesAgo(6)
    ).lastInsertRowid)

    if (!room.queen_worker_id) {
      db.prepare('UPDATE rooms SET queen_worker_id = ?, updated_at = ? WHERE id = ?').run(roomQueenId, nowIso, roomId)
    }

    db.prepare('UPDATE rooms SET autonomy_mode = ?, worker_model = ?, updated_at = ? WHERE id = ?').run('semi', 'claude', nowIso, roomId)

    let walletRow = getRoomWallet.get(roomId)
    let walletId
    if (walletRow && walletRow.id) {
      walletId = Number(walletRow.id)
    } else {
      const addr = `0x${roomId.toString(16).padStart(40, '0').slice(-40)}`
      walletId = Number(insertWallet.run(
        roomId,
        addr,
        `enc:v1:${roomPrefix}_wallet`,
        'base',
        `${roomPrefix}_agent`,
        isoMinutesAgo(40)
      ).lastInsertRowid)
    }

    insertWalletTx.run(walletId, 'fund', '120.00', `${roomPrefix} Treasury`, `0xtx_${roomId}_fund`, `${roomPrefix} Initial funding`, 'confirmed', null, isoMinutesAgo(35))
    insertWalletTx.run(walletId, 'receive', '34.00', `${roomPrefix} Customer`, `0xtx_${roomId}_in`, `${roomPrefix} Service payment`, 'confirmed', 'revenue', isoMinutesAgo(18))
    insertWalletTx.run(walletId, 'purchase', '9.00', `${roomPrefix} Cloud`, `0xtx_${roomId}_station`, `${roomPrefix} Station fee`, 'confirmed', 'station_cost', isoMinutesAgo(12))
    insertWalletTx.run(walletId, 'send', '6.50', `${roomPrefix} Vendor`, `0xtx_${roomId}_out`, `${roomPrefix} Tool subscription`, 'confirmed', 'ops', isoMinutesAgo(7))

    insertStation.run(roomId, `${roomPrefix} station-main`, 'fly', `${roomPrefix}-fly-1`, 'small', 'iad', 'active', 25, '{"cpu":2}', isoMinutesAgo(22), isoMinutesAgo(5))
    insertStation.run(roomId, `${roomPrefix} station-backup`, 'fly', `${roomPrefix}-fly-2`, 'micro', 'sjc', 'stopped', 9, '{"cpu":1}', isoMinutesAgo(20), isoMinutesAgo(9))

    const roomEntityId = Number(insertEntity.run(`${roomPrefix} Entity Pipeline`, 'system', 'operations', roomId, isoMinutesAgo(21), isoMinutesAgo(4)).lastInsertRowid)
    const roomMarketEntityId = Number(insertEntity.run(`${roomPrefix} Segment SMB`, 'market', 'revenue', roomId, isoMinutesAgo(20), isoMinutesAgo(6)).lastInsertRowid)
    insertObs.run(roomEntityId, `${roomPrefix} Pipeline stable with one pending blocker.`, 'style-seed', isoMinutesAgo(4))
    insertObs.run(roomMarketEntityId, `${roomPrefix} SMB segment yields better conversion this week.`, 'style-seed', isoMinutesAgo(6))
    seedEntityEmbedding(roomEntityId, `${roomPrefix} Entity Pipeline ${roomPrefix} Pipeline stable with one pending blocker.`, isoMinutesAgo(4))
    seedEntityEmbedding(roomMarketEntityId, `${roomPrefix} Segment SMB ${roomPrefix} SMB segment yields better conversion this week.`, isoMinutesAgo(6))
    insertRelation.run(roomEntityId, roomMarketEntityId, 'supports', isoMinutesAgo(5))

    const roomTaskId = Number(insertTask.run(
      `${roomPrefix} Daily Sync`,
      'Summarize execution status and blockers.',
      'Compile worker updates and list next actions.',
      '*/20 * * * *',
      'cron',
      '{"timezone":"UTC"}',
      'claude_code',
      'active',
      isoMinutesAgo(4),
      `${roomPrefix} Summary generated`,
      0,
      isoMinutesAgo(16),
      null,
      5,
      roomEntityId,
      roomOpsId,
      1,
      `${roomPrefix}-sess-sync`,
      20,
      6,
      'search,write',
      null,
      'Prefer concise bullet summaries',
      roomId,
      isoMinutesAgo(26),
      isoMinutesAgo(4)
    ).lastInsertRowid)

    const roomTaskRunId = Number(insertRun.run(
      roomTaskId,
      isoMinutesAgo(3),
      null,
      'running',
      null,
      null,
      null,
      null,
      0.5,
      `${roomPrefix} Gathering worker updates`,
      `${roomPrefix}-sess-sync`
    ).lastInsertRowid)

    insertLog.run(roomTaskRunId, 1, 'assistant_text', `${roomPrefix} Starting sync cycle.`, isoMinutesAgo(3))
    insertLog.run(roomTaskRunId, 2, 'tool_call', `${roomPrefix} query recent run states`, isoMinutesAgo(2))
    insertLog.run(roomTaskRunId, 3, 'tool_result', `${roomPrefix} Collected 3 worker updates`, isoMinutesAgo(2))

    const roomGoalTopId = Number(insertGoal.run(roomId, `${roomPrefix} Increase weekly net margin`, 'in_progress', null, roomQueenId, 0.44, isoMinutesAgo(24), isoMinutesAgo(4)).lastInsertRowid)
    const roomGoalChildId = Number(insertGoal.run(roomId, `${roomPrefix} Cut station idle time`, 'active', roomGoalTopId, roomOpsId, 0.31, isoMinutesAgo(23), isoMinutesAgo(5)).lastInsertRowid)
    insertGoalUpdate.run(roomGoalTopId, roomQueenId, `${roomPrefix} Margin trend improved after pruning spend.`, 0.44, isoMinutesAgo(4))
    insertGoalUpdate.run(roomGoalChildId, roomOpsId, `${roomPrefix} Two idle windows identified.`, 0.31, isoMinutesAgo(5))

    insertSkill.run(roomId, `${roomPrefix} Ops Summary Skill`, 'Generate concise daily operating summary with blocker routing.', JSON.stringify(['operations', 'status']), 1, 1, roomOpsId, 1, isoMinutesAgo(22), isoMinutesAgo(4))
    insertSkill.run(roomId, `${roomPrefix} Growth Triage Skill`, 'Prioritize experiments by expected net impact.', JSON.stringify(['growth', 'prioritization']), 0, 0, roomGrowthId, 1, isoMinutesAgo(21), isoMinutesAgo(6))

    insertCred.run(roomId, `${PREFIX}_OPENAI_${roomId}`, 'api_key', `enc:v1:${roomPrefix}_openai_key`, 'keeper', isoMinutesAgo(20))
    insertCred.run(roomId, `${PREFIX}_ANTHROPIC_${roomId}`, 'api_key', `enc:v1:${roomPrefix}_anthropic_key`, 'keeper', isoMinutesAgo(19))

    const roomDecisionVotingId = Number(insertDecision.run(
      roomId,
      roomQueenId,
      `${roomPrefix} Reallocate 15% budget to higher ROAS channel`,
      'resource',
      'voting',
      null,
      'majority',
      isoMinutesAgo(-30),
      isoMinutesAgo(8),
      null
    ).lastInsertRowid)
    const roomDecisionResolvedId = Number(insertDecision.run(
      roomId,
      roomGrowthId,
      `${roomPrefix} Prioritize retention copy update`,
      'strategy',
      'approved',
      `${roomPrefix} Approved by quorum`,
      'majority',
      isoMinutesAgo(80),
      isoMinutesAgo(50),
      isoMinutesAgo(45)
    ).lastInsertRowid)
    insertVote.run(roomDecisionVotingId, roomOpsId, 'yes', `${roomPrefix} Positive expected margin effect.`, isoMinutesAgo(7))
    insertVote.run(roomDecisionVotingId, roomGrowthId, 'abstain', `${roomPrefix} Need one more sample day.`, isoMinutesAgo(6))
    insertVote.run(roomDecisionResolvedId, roomOpsId, 'yes', `${roomPrefix} Low effort, high upside.`, isoMinutesAgo(46))

    insertEsc.run(roomId, roomOpsId, roomQueenId, `${roomPrefix} Need approval for station restart window`, null, 'pending', isoMinutesAgo(5), null)
    insertEsc.run(roomId, roomGrowthId, roomQueenId, `${roomPrefix} Can we pause low-performing ad set?`, `${roomPrefix} Yes, pause and re-check tomorrow.`, 'resolved', isoMinutesAgo(15), isoMinutesAgo(13))

    insertRoomMsg.run(roomId, 'inbound', `style_room_${roomBetaId}`, null, `${roomPrefix} Cross-room insight`, `${roomPrefix} Sharing competitor pricing snapshot.`, 'unread', isoMinutesAgo(4))
    insertRoomMsg.run(roomId, 'outbound', null, `style_room_${roomGammaId}`, `${roomPrefix} Ops request`, `${roomPrefix} Need infra estimate by EOD.`, 'replied', isoMinutesAgo(11))

    insertWatch.run(`/tmp/style-demo/room-${roomId}/events`, `${roomPrefix} Watch events`, 'Summarize meaningful file changes', 'active', isoMinutesAgo(6), 4, roomId, isoMinutesAgo(18))
    insertWatch.run(`/tmp/style-demo/room-${roomId}/alerts`, `${roomPrefix} Watch alerts`, 'Escalate urgent alerts to queen', 'paused', isoMinutesAgo(30), 2, roomId, isoMinutesAgo(17))

    insertActivity.run(roomId, 'decision', roomQueenId, `${roomPrefix} Budget vote opened`, `${roomPrefix} Waiting for remaining worker votes.`, 1, isoMinutesAgo(8))
    insertActivity.run(roomId, 'milestone', roomOpsId, `${roomPrefix} Daily sync published`, `${roomPrefix} Next actions distributed.`, 1, isoMinutesAgo(4))
    insertActivity.run(roomId, 'financial', roomGrowthId, `${roomPrefix} New payment received`, `${roomPrefix} +$34 recorded in wallet.`, 1, isoMinutesAgo(18))
    insertActivity.run(roomId, 'error', roomOpsId, `${roomPrefix} Minor API timeout`, `${roomPrefix} Retried successfully.`, 1, isoMinutesAgo(9))
    insertActivity.run(roomId, 'self_mod', roomOpsId, `${roomPrefix} Retry policy adjusted`, `${roomPrefix} Increased backoff for transient failures.`, 1, isoMinutesAgo(6))

    insertAudit.run(roomId, roomOpsId, `/style-demo/room-${roomId}/worker-loop.ts`, `oldhash-${roomId}-1`, `newhash-${roomId}-1`, `${roomPrefix} Adjust retry backoff and queue flush`, 1, 0, isoMinutesAgo(6))

    insertChat.run(roomId, 'user', `${roomPrefix} What should we focus on today?`, isoMinutesAgo(3))
    insertChat.run(roomId, 'assistant', `${roomPrefix} Focus on margin, unblock pending vote, and close top lead.`, isoMinutesAgo(2))
  }
})()

db.close()

console.log(`Seed complete: ${dbPath}`)
console.log('Created rooms: STYLE_DEMO Room Alpha, STYLE_DEMO Room Beta, STYLE_DEMO Room Gamma')
console.log('Created invite-linked referred rooms: 20 STYLE_DEMO Invite Alpha/Beta/Gamma variants')
console.log('Also injected STYLE_DEMO data into all existing non-stopped rooms (including your current room).')
console.log('Note: Stations/Billing cloud subscription history is served by cloud API data, not local room.db.')
