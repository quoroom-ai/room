/**
 * Database schema — creates all tables idempotently.
 * Uses CREATE TABLE IF NOT EXISTS so it's safe to run on any database.
 *
 * IMPORTANT: Table order matters because PRAGMA foreign_keys = ON.
 * Tables must be created before any table that REFERENCES them.
 * Order: settings → workers → rooms → entities → everything else
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Settings (no dependencies)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);

-- Workers (no FK dependencies)
CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT,
    system_prompt TEXT NOT NULL,
    description TEXT,
    model TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    task_count INTEGER NOT NULL DEFAULT 0,
    room_id INTEGER,
    agent_state TEXT NOT NULL DEFAULT 'idle',
    votes_cast INTEGER NOT NULL DEFAULT 0,
    votes_missed INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_workers_name ON workers(name);

-- Rooms (references workers)
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    queen_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    visibility TEXT NOT NULL DEFAULT 'private',
    autonomy_mode TEXT NOT NULL DEFAULT 'auto',
    max_concurrent_tasks INTEGER NOT NULL DEFAULT 3,
    worker_model TEXT NOT NULL DEFAULT 'ollama:llama3.2',
    queen_cycle_gap_ms INTEGER NOT NULL DEFAULT 1800000,
    queen_max_turns INTEGER NOT NULL DEFAULT 3,
    queen_quiet_from TEXT,
    queen_quiet_until TEXT,
    config TEXT,
    chat_session_id TEXT,
    referred_by_code TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);

-- Memory: entities, observations, relations (entities references rooms)
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'fact',
    category TEXT,
    embedded_at DATETIME,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_room ON entities(room_id);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'claude',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_observations_entity_id ON observations(entity_id);

CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    name, content, category, content='entities', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO memory_fts(rowid, name, content, category) VALUES (new.id, new.name, '', new.category);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, name, content, category) VALUES ('delete', old.id, old.name, '', old.category);
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, name, content, category) VALUES ('delete', old.id, old.name, '', old.category);
    INSERT INTO memory_fts(rowid, name, content, category) VALUES (new.id, new.name, '', new.category);
END;

-- Embeddings (semantic search)
CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL DEFAULT 'entity',
    source_id INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    dimensions INTEGER NOT NULL DEFAULT 384,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_entity_id ON embeddings(entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id, model);

-- Tasks (references entities, workers, rooms)
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT NOT NULL,
    cron_expression TEXT,
    trigger_type TEXT NOT NULL DEFAULT 'cron',
    trigger_config TEXT,
    executor TEXT NOT NULL DEFAULT 'claude_code',
    status TEXT NOT NULL DEFAULT 'active',
    last_run DATETIME,
    last_result TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    scheduled_at DATETIME,
    max_runs INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    memory_entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    session_continuity INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    timeout_minutes INTEGER,
    max_turns INTEGER,
    allowed_tools TEXT,
    disallowed_tools TEXT,
    learned_context TEXT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_trigger_type ON tasks(trigger_type);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id);

-- Task runs
CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    started_at DATETIME DEFAULT (datetime('now','localtime')),
    finished_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running',
    result TEXT,
    result_file TEXT,
    error_message TEXT,
    duration_ms INTEGER,
    progress REAL,
    progress_message TEXT,
    session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_started_at ON task_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);

-- Console logs
CREATE TABLE IF NOT EXISTS console_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_console_logs_run_seq ON console_logs(run_id, seq);

-- File watchers
CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    description TEXT,
    action_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_triggered DATETIME,
    trigger_count INTEGER NOT NULL DEFAULT 0,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_watches_room ON watches(room_id);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id);

-- Room activity
CREATE TABLE IF NOT EXISTS room_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_id INTEGER,
    summary TEXT NOT NULL,
    details TEXT,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_room_activity_room ON room_activity(room_id);
CREATE INDEX IF NOT EXISTS idx_room_activity_type ON room_activity(event_type);

-- Quorum decisions
CREATE TABLE IF NOT EXISTS quorum_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    proposer_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    proposal TEXT NOT NULL,
    decision_type TEXT NOT NULL DEFAULT 'low_impact',
    status TEXT NOT NULL DEFAULT 'voting',
    result TEXT,
    threshold TEXT NOT NULL DEFAULT 'majority',
    timeout_at DATETIME,
    keeper_vote TEXT,
    min_voters INTEGER NOT NULL DEFAULT 0,
    sealed INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_quorum_decisions_room ON quorum_decisions(room_id);
CREATE INDEX IF NOT EXISTS idx_quorum_decisions_status ON quorum_decisions(status);

-- Quorum votes
CREATE TABLE IF NOT EXISTS quorum_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL REFERENCES quorum_decisions(id) ON DELETE CASCADE,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    vote TEXT NOT NULL,
    reasoning TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    UNIQUE(decision_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_quorum_votes_decision ON quorum_votes(decision_id);

-- Goals
CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    parent_goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
    assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    progress REAL NOT NULL DEFAULT 0.0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_goals_room ON goals(room_id);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

-- Goal updates
CREATE TABLE IF NOT EXISTS goal_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    observation TEXT NOT NULL,
    metric_value REAL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_goal_updates_goal ON goal_updates(goal_id);

-- Skills
CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    activation_context TEXT,
    auto_activate INTEGER NOT NULL DEFAULT 0,
    agent_created INTEGER NOT NULL DEFAULT 0,
    created_by_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_skills_room ON skills(room_id);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

-- Self-modification audit
CREATE TABLE IF NOT EXISTS self_mod_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    old_hash TEXT,
    new_hash TEXT,
    reason TEXT,
    reversible INTEGER NOT NULL DEFAULT 1,
    reverted INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_self_mod_audit_room ON self_mod_audit(room_id);

-- Self-modification snapshots (for true revert of reversible edits)
CREATE TABLE IF NOT EXISTS self_mod_snapshots (
    audit_id INTEGER PRIMARY KEY REFERENCES self_mod_audit(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    old_content TEXT,
    new_content TEXT
);
CREATE INDEX IF NOT EXISTS idx_self_mod_snapshots_target ON self_mod_snapshots(target_type, target_id);

-- Escalations
CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    from_agent_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    to_agent_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_escalations_room ON escalations(room_id);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);

-- Credentials
CREATE TABLE IF NOT EXISTS credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    value_encrypted TEXT NOT NULL,
    provided_by TEXT NOT NULL DEFAULT 'keeper',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_room ON credentials(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_room_name ON credentials(room_id, name);

-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'base',
    erc8004_agent_id TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_wallets_room ON wallets(room_id);

-- Wallet transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount TEXT NOT NULL,
    counterparty TEXT,
    tx_hash TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    category TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id);

-- Room messages (inter-room messaging)
CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    from_room_id TEXT,
    to_room_id TEXT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_room_messages_status ON room_messages(status);

-- Stations
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    external_id TEXT,
    tier TEXT NOT NULL,
    region TEXT,
    status TEXT NOT NULL DEFAULT 'provisioning',
    monthly_cost REAL NOT NULL DEFAULT 0,
    config TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stations_room ON stations(room_id);

-- Worker cycles (agent loop execution tracking)
CREATE TABLE IF NOT EXISTS worker_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL,
    model TEXT,
    started_at DATETIME DEFAULT (datetime('now','localtime')),
    finished_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_worker_cycles_room ON worker_cycles(room_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_cycles_status ON worker_cycles(status);

-- Cycle logs (streaming output from agent cycles)
CREATE TABLE IF NOT EXISTS cycle_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL REFERENCES worker_cycles(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cycle_logs_seq ON cycle_logs(cycle_id, seq);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
`
