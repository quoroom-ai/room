import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { propose, vote, tally } from './quorum'
import { updateGoalProgress, decomposeGoal, completeGoal, abandonGoal, setRoomObjective } from './goals'
import type { DecisionType, VoteValue } from './types'
import { webFetch, webSearch, browserAction, type BrowserAction } from './web-tools'
import { WORKER_ROLE_PRESETS } from './constants'

// ─── Tool definition format (OpenAI-compatible) ─────────────────────────────

export interface ToolProperty {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolProperty>
      required?: string[]
    }
  }
}

// ─── All queen tool definitions ─────────────────────────────────────────────

export const QUEEN_TOOL_DEFINITIONS: ToolDef[] = [
  // ── Goals ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_set_goal',
      description: 'Set or update the room\'s primary objective.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The objective description' }
        },
        required: ['description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_update_progress',
      description: 'Log a progress observation on a goal. Optionally set a metric value from 0.0 to 1.0.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'number', description: 'The goal ID' },
          observation: { type: 'string', description: 'Description of the progress made' },
          metricValue: { type: 'number', description: 'Progress value from 0.0 (0%) to 1.0 (100%)' }
        },
        required: ['goalId', 'observation']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_create_subgoal',
      description: 'Decompose a goal into smaller sub-goals.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'number', description: 'The parent goal ID' },
          descriptions: {
            type: 'array',
            description: 'Array of sub-goal descriptions',
            items: { type: 'string' }
          }
        },
        required: ['goalId', 'descriptions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_complete_goal',
      description: 'Mark a goal as completed (100% progress).',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'number', description: 'The goal ID to mark as completed' }
        },
        required: ['goalId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_abandon_goal',
      description: 'Mark a goal as abandoned with a reason.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'number', description: 'The goal ID to abandon' },
          reason: { type: 'string', description: 'Reason for abandoning this goal' }
        },
        required: ['goalId', 'reason']
      }
    }
  },

  // ── Quorum ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_propose',
      description: 'Create a proposal for the room quorum to vote on. Low-impact decisions may be auto-approved.',
      parameters: {
        type: 'object',
        properties: {
          proposal: { type: 'string', description: 'The proposal text' },
          decisionType: {
            type: 'string',
            description: 'Type of decision',
            enum: ['strategy', 'resource', 'personnel', 'rule_change', 'low_impact']
          }
        },
        required: ['proposal', 'decisionType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_vote',
      description: 'Cast a vote on a pending quorum decision.',
      parameters: {
        type: 'object',
        properties: {
          decisionId: { type: 'number', description: 'The decision ID' },
          vote: { type: 'string', description: 'Vote: yes, no, or abstain', enum: ['yes', 'no', 'abstain'] },
          reasoning: { type: 'string', description: 'Optional reasoning for the vote' }
        },
        required: ['decisionId', 'vote']
      }
    }
  },

  // ── Workers ────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_create_worker',
      description: 'Create a new agent worker. REQUIRED: name (string, e.g. "Alice") and systemPrompt (string, the agent\'s instructions). Do NOT pass worker_id or room_id — this creates a NEW worker. Role presets (guardian/analyst/writer) auto-apply cycle_gap_ms and max_turns defaults unless overridden.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The worker\'s name, e.g. "Alice" or "Research Agent"' },
          systemPrompt: { type: 'string', description: 'Full instructions for this worker — personality, goals, constraints. E.g. "You are a research agent. Your job is to..."' },
          role: { type: 'string', description: 'Optional job title or role preset. Built-in presets with execution defaults: "guardian" (60s cycle, 5 turns, monitoring-focused), "analyst" (300s cycle, 15 turns), "writer" (300s cycle, 20 turns).' },
          description: { type: 'string', description: 'Optional one-line summary of what this worker does' },
          cycle_gap_ms: { type: 'number', description: 'Override cycle gap in milliseconds (default: role preset or room default)' },
          max_turns: { type: 'number', description: 'Override max turns per cycle (default: role preset or room default)' }
        },
        required: ['name', 'systemPrompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_update_worker',
      description: 'Update an existing worker\'s name, role, system prompt, description, or execution settings.',
      parameters: {
        type: 'object',
        properties: {
          workerId: { type: 'number', description: 'The worker ID to update' },
          name: { type: 'string', description: 'New name' },
          role: { type: 'string', description: 'New role/function title' },
          systemPrompt: { type: 'string', description: 'New system prompt' },
          description: { type: 'string', description: 'New description' },
          cycle_gap_ms: { type: 'number', description: 'Override cycle gap in milliseconds (null to reset to room default)' },
          max_turns: { type: 'number', description: 'Override max turns per cycle (null to reset to room default)' }
        },
        required: ['workerId']
      }
    }
  },

  // ── Tasks ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_schedule',
      description: 'Create a task for workers to execute — recurring (cron), one-time, or on-demand. The prompt runs as a separate Claude instance so must be fully self-contained.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short task name' },
          prompt: { type: 'string', description: 'Fully self-contained prompt that the task will execute' },
          cronExpression: { type: 'string', description: 'Cron expression for recurring tasks (e.g. "0 9 * * *" for daily 9am). Omit for one-time or on-demand.' },
          scheduledAt: { type: 'string', description: 'ISO-8601 datetime for one-time tasks. Omit for recurring or on-demand.' },
          workerId: { type: 'number', description: 'Worker ID to assign this task to' },
          maxTurns: { type: 'number', description: 'Max agentic turns per run (e.g. 25)' }
        },
        required: ['name', 'prompt']
      }
    }
  },

  // ── Memory ─────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_remember',
      description: 'Store a memory or observation for later recall. Use for facts, insights, decisions, or project details.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short label for this memory (e.g. "Q1 budget decision")' },
          content: { type: 'string', description: 'The detailed information to remember' },
          type: {
            type: 'string',
            description: 'Memory type',
            enum: ['fact', 'preference', 'person', 'project', 'event']
          }
        },
        required: ['name', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_recall',
      description: 'Search stored memories by keyword.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keyword or phrase' }
        },
        required: ['query']
      }
    }
  },

  // ── Keeper messaging ───────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_ask_keeper',
      description: 'Send a question or request to the keeper (human operator). Use for decisions that require human input.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question or request for the keeper' }
        },
        required: ['question']
      }
    }
  },

  // ── Room config ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_configure_room',
      description: 'Adjust queen cycle settings to self-regulate token usage.',
      parameters: {
        type: 'object',
        properties: {
          queenCycleGapMs: {
            type: 'number',
            description: 'Milliseconds between queen cycles (e.g. 300000 = 5 min, 1800000 = 30 min)'
          },
          queenMaxTurns: {
            type: 'number',
            description: 'Max tool-call turns per queen cycle (1–50)'
          }
        }
      }
    }
  },

  // ── Web / Internet access ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_web_search',
      description: 'Search the web. Returns top 5 results with title, URL, and snippet. No API key required.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_web_fetch',
      description: 'Fetch any URL and return its content as clean markdown text. Use to read articles, docs, pricing pages, or any public web page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL (https://...)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_browser',
      description: 'Control a headless browser to interact with websites: navigate pages, click buttons, fill forms, buy services, register domains. Returns accessibility tree snapshot of the page. Use for tasks requiring user interaction that quoroom_web_fetch cannot handle.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Starting URL' },
          actions: {
            type: 'array',
            description: 'Sequence of browser actions. Each action is an object with required "type" field (one of: navigate, click, fill, select, wait, submit, snapshot) plus optional fields: url (navigate), text/selector (click), selector+value (fill/select), ms (wait), selector (submit).',
            items: { type: 'object' }
          }
        },
        required: ['url', 'actions']
      }
    }
  },
  // ── Wallet ──────────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'quoroom_wallet_balance',
      description: 'Get the room\'s wallet balance (USDC). Returns address and transaction summary.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_wallet_send',
      description: 'Send USDC from the room\'s wallet to an address.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address (0x...)' },
          amount: { type: 'string', description: 'Amount (e.g., "10.50")' }
        },
        required: ['to', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_wallet_history',
      description: 'Get recent wallet transaction history.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'string', description: 'Max transactions to return (default: 10)' }
        }
      }
    }
  }
]

// ─── Tool executor ──────────────────────────────────────────────────────────

export type QueenToolArgs = Record<string, unknown>

export interface QueenToolResult {
  content: string
  isError?: boolean
}

export async function executeQueenTool(
  db: Database.Database,
  roomId: number,
  workerId: number,
  toolName: string,
  args: QueenToolArgs
): Promise<QueenToolResult> {
  try {
    switch (toolName) {

      // ── Goals ────────────────────────────────────────────────────────
      case 'quoroom_set_goal': {
        const description = String(args.description ?? '')
        const goal = setRoomObjective(db, roomId, description)
        queries.updateRoom(db, roomId, { goal: description })
        return { content: `Room goal set: "${description}" (goal #${goal.id})` }
      }

      case 'quoroom_update_progress': {
        const goalId = Number(args.goalId ?? args.goal_id)
        if (!goalId || isNaN(goalId)) return { content: 'Error: goalId is required for quoroom_update_progress. Provide the numeric goal ID.', isError: true }
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `Error: goal #${goalId} not found.`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `Error: goal #${goalId} belongs to another room. Your room's goals are shown in the Active Goals section — use those goal IDs.`, isError: true }
        const observation = String(args.observation ?? args.progress ?? args.message ?? args.text ?? '')
        const metricValue = args.metricValue != null ? Number(args.metricValue) : (args.metric_value != null ? Number(args.metric_value) : undefined)
        const subGoals = queries.getSubGoals(db, goalId)
        updateGoalProgress(db, goalId, observation, metricValue, workerId)
        const goal = queries.getGoal(db, goalId)
        const pct = Math.round((goal?.progress ?? 0) * 100)
        const note = subGoals.length > 0 && metricValue != null
          ? ` (metricValue ignored — goal has ${subGoals.length} sub-goals, progress is calculated from them. Update sub-goals directly.)`
          : ''
        return { content: `Progress logged on goal #${goalId}. Now at ${pct}%.${note}` }
      }

      case 'quoroom_create_subgoal': {
        const goalId = Number(args.goalId)
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `Error: goal #${goalId} not found.`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `Error: goal #${goalId} belongs to another room.`, isError: true }
        const raw = args.descriptions
        const descriptions = Array.isArray(raw) ? raw.map(String) : [String(raw)]
        const subGoals = decomposeGoal(db, goalId, descriptions)
        return { content: `Created ${subGoals.length} sub-goal(s) under goal #${goalId}.` }
      }

      case 'quoroom_complete_goal': {
        const goalId = Number(args.goalId)
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `Error: goal #${goalId} not found.`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `Error: goal #${goalId} belongs to another room.`, isError: true }
        completeGoal(db, goalId)
        return { content: `Goal #${goalId} marked as completed.` }
      }

      case 'quoroom_abandon_goal': {
        const goalId = Number(args.goalId)
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `Error: goal #${goalId} not found.`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `Error: goal #${goalId} belongs to another room.`, isError: true }
        const reason = String(args.reason ?? 'No reason given')
        abandonGoal(db, goalId, reason)
        return { content: `Goal #${goalId} abandoned: ${reason}` }
      }

      // ── Quorum ───────────────────────────────────────────────────────
      case 'quoroom_propose': {
        // Tolerate common small-model arg name variations
        const proposalText = String(args.proposal ?? args.text ?? args.description ?? args.content ?? args.idea ?? '').trim()
        if (!proposalText) return { content: 'Error: proposal text is required. Provide a "proposal" string.', isError: true }
        // De-dup: reject if a similar proposal is pending or was recently approved
        const recentDecisions = queries.listDecisions(db, roomId)
        const isDuplicate = recentDecisions.slice(0, 10).some(d =>
          (d.status === 'voting' || d.status === 'approved') &&
          d.proposal.toLowerCase() === proposalText.toLowerCase()
        )
        if (isDuplicate) {
          return { content: `A similar proposal already exists: "${proposalText}". No need to propose again.`, isError: true }
        }
        const decisionType = String(args.decisionType ?? args.type ?? args.impact ?? args.category ?? 'low_impact') as DecisionType
        const decision = propose(db, {
          roomId,
          proposerId: workerId,
          proposal: proposalText,
          decisionType
        })
        if (decision.status === 'approved') {
          return { content: `Proposal auto-approved: "${proposalText}"` }
        }
        // Auto-cast queen's YES vote so proposals don't deadlock in small rooms
        try {
          vote(db, decision.id, workerId, 'yes')
          const resolved = tally(db, decision.id)
          if (resolved === 'approved') {
            return { content: `Proposal approved: "${proposalText}"` }
          }
        } catch { /* non-fatal if already voted */ }
        return { content: `Proposal #${decision.id} created and voted YES: "${proposalText}" (waiting for others)` }
      }

      case 'quoroom_vote': {
        vote(
          db,
          Number(args.decisionId),
          workerId,
          String(args.vote ?? 'abstain') as VoteValue,
          args.reasoning ? String(args.reasoning) : undefined
        )
        const decision = queries.getDecision(db, Number(args.decisionId))
        if (decision && decision.status !== 'voting') {
          return { content: `Vote cast. Decision resolved: ${decision.status}` }
        }
        return { content: `Vote "${args.vote}" cast on decision #${args.decisionId}.` }
      }

      // ── Workers ──────────────────────────────────────────────────────
      case 'quoroom_create_worker': {
        // Tolerate common model hallucinations for arg names
        const name = String(args.name ?? args.workerName ?? args.worker_name ?? args.type ?? args.role ?? '').trim()
        const systemPrompt = String(args.systemPrompt ?? args.system_prompt ?? args.instructions ?? args.prompt ?? '').trim()
        if (!name) return { content: 'Error: name is required for quoroom_create_worker. Provide a "name" string.', isError: true }
        if (!systemPrompt) return { content: 'Error: systemPrompt is required for quoroom_create_worker. Provide a "systemPrompt" string describing this worker\'s role and instructions.', isError: true }
        // De-dup: reject if worker with same name already exists in this room
        const existingWorkers = queries.listRoomWorkers(db, roomId)
        if (existingWorkers.some(w => w.name.toLowerCase() === name.toLowerCase())) {
          return { content: `Worker "${name}" already exists in this room. Use quoroom_update_worker to modify it, or choose a different name.`, isError: true }
        }
        const role = args.role && args.role !== args.name ? String(args.role) : undefined
        const description = args.description ? String(args.description) : undefined
        // Apply role preset defaults (explicit args override preset)
        const preset = role ? WORKER_ROLE_PRESETS[role] : undefined
        const cycleGapMs = args.cycle_gap_ms != null ? Number(args.cycle_gap_ms) : (preset?.cycleGapMs ?? null)
        const maxTurns = args.max_turns != null ? Number(args.max_turns) : (preset?.maxTurns ?? null)
        queries.createWorker(db, { name, role, systemPrompt, description, cycleGapMs, maxTurns, roomId })
        const presetNote = preset && (cycleGapMs || maxTurns)
          ? ` [${role} preset: ${cycleGapMs ? `${cycleGapMs / 1000}s cycle` : ''}${cycleGapMs && maxTurns ? ', ' : ''}${maxTurns ? `${maxTurns} turns` : ''}]`
          : ''
        return { content: `Created worker "${name}"${role ? ` (${role})` : ''}${presetNote}.` }
      }

      case 'quoroom_update_worker': {
        const wId = Number(args.workerId)
        const w = queries.getWorker(db, wId)
        if (!w) return { content: `Worker #${wId} not found.`, isError: true }
        const updates: Record<string, unknown> = {}
        if (args.name !== undefined) updates.name = String(args.name)
        if (args.role !== undefined) updates.role = String(args.role)
        if (args.systemPrompt !== undefined) updates.systemPrompt = String(args.systemPrompt)
        if (args.description !== undefined) updates.description = String(args.description)
        if (args.cycle_gap_ms !== undefined) updates.cycleGapMs = args.cycle_gap_ms === null ? null : Number(args.cycle_gap_ms)
        if (args.max_turns !== undefined) updates.maxTurns = args.max_turns === null ? null : Number(args.max_turns)
        queries.updateWorker(db, wId, updates)
        return { content: `Updated worker "${w.name}".` }
      }

      // ── Tasks ────────────────────────────────────────────────────────
      case 'quoroom_schedule': {
        const name = String(args.name ?? 'Unnamed task')
        const prompt = String(args.prompt ?? '')
        const cronExpression = args.cronExpression ? String(args.cronExpression) : undefined
        const scheduledAt = args.scheduledAt ? String(args.scheduledAt) : undefined
        const taskWorkerId = args.workerId ? Number(args.workerId) : undefined
        const maxTurns = args.maxTurns ? Number(args.maxTurns) : undefined
        const triggerType: 'cron' | 'once' | 'manual' = cronExpression ? 'cron' : scheduledAt ? 'once' : 'manual'

        // De-dup: reject if active task with same name exists in this room
        const existingTasks = queries.listTasks(db, roomId, 'active')
        if (existingTasks.some(t => t.name.toLowerCase() === name.toLowerCase())) {
          return { content: `Task "${name}" already exists. Choose a different name or manage the existing task.`, isError: true }
        }

        // Validate workerId belongs to this room — prevents cross-room assignment
        if (taskWorkerId) {
          const taskWorker = queries.getWorker(db, taskWorkerId)
          if (!taskWorker || taskWorker.roomId !== roomId) {
            return { content: `Error: Worker #${taskWorkerId} does not belong to this room. Use a workerId from this room (see Room Workers section), or omit workerId to use the default.`, isError: true }
          }
        }

        queries.createTask(db, {
          name,
          prompt,
          triggerType,
          cronExpression,
          scheduledAt,
          workerId: taskWorkerId,
          maxTurns,
          roomId,
          executor: 'claude_code',
          triggerConfig: JSON.stringify({ source: 'queen' })
        })
        return { content: `Task "${name}" created (${triggerType}).` }
      }

      // ── Memory ───────────────────────────────────────────────────────
      case 'quoroom_remember': {
        const name = String(args.name ?? '')
        const content = String(args.content ?? '')
        const type = String(args.type ?? 'fact') as 'fact' | 'preference' | 'person' | 'project' | 'event'
        // De-dup: if entity with same name exists in this room, add observation instead of creating duplicate
        const existing = queries.listEntities(db, roomId).find(e => e.name.toLowerCase() === name.toLowerCase())
        if (existing) {
          queries.addObservation(db, existing.id, content, 'queen')
          return { content: `Updated memory "${name}" (added new observation to existing entry).` }
        }
        const entity = queries.createEntity(db, name, type, undefined, roomId)
        queries.addObservation(db, entity.id, content, 'queen')
        return { content: `Remembered "${name}".` }
      }

      case 'quoroom_recall': {
        const query = String(args.query ?? '')
        const results = queries.hybridSearch(db, query, null)
        if (results.length === 0) return { content: `No memories found for "${query}".` }
        const summary = results.slice(0, 5).map(r => {
          const obs = queries.getObservations(db, r.entity.id)
          return `• ${r.entity.name}: ${obs[0]?.content ?? '(no content)'}`
        }).join('\n')
        return { content: summary }
      }

      // ── Keeper messaging ─────────────────────────────────────────────
      case 'quoroom_ask_keeper': {
        const question = String(args.question ?? '')
        const escalation = queries.createEscalation(db, roomId, workerId, question)
        const deliveryStatus = await deliverQueenMessage(db, roomId, question)
        const deliveryNote = deliveryStatus ? ` ${deliveryStatus}` : ''
        return { content: `Question sent to keeper (escalation #${escalation.id}).${deliveryNote}` }
      }

      // ── Room config ──────────────────────────────────────────────────
      case 'quoroom_configure_room': {
        const updates: Parameters<typeof queries.updateRoom>[2] = {}
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(10_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (Object.keys(updates).length > 0) {
          queries.updateRoom(db, roomId, updates)
          return { content: `Room configured: ${JSON.stringify(updates)}` }
        }
        return { content: 'No changes applied.' }
      }

      // ── Web / Internet access ────────────────────────────────────────
      case 'quoroom_web_search': {
        const query = String(args.query ?? '').trim()
        if (!query) return { content: 'Error: query is required', isError: true }
        const results = await webSearch(query)
        if (results.length === 0) return { content: 'No results found.' }
        return { content: results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join('\n\n') }
      }

      case 'quoroom_web_fetch': {
        const url = String(args.url ?? '').trim()
        if (!url) return { content: 'Error: url is required', isError: true }
        return { content: await webFetch(url) }
      }

      case 'quoroom_browser': {
        const url = String(args.url ?? '').trim()
        const actions = (args.actions ?? []) as BrowserAction[]
        if (!url) return { content: 'Error: url is required', isError: true }
        return { content: await browserAction(url, actions) }
      }

      // ── Wallet ────────────────────────────────────────────────────
      case 'quoroom_wallet_balance': {
        const wallet = queries.getWalletByRoom(db, roomId)
        if (!wallet) return { content: 'No wallet found for this room.', isError: true }
        const summary = queries.getWalletTransactionSummary(db, wallet.id)
        const net = (parseFloat(summary.received) - parseFloat(summary.sent)).toFixed(2)
        return { content: `Wallet ${wallet.address}: ${net} USDC (received: ${summary.received}, sent: ${summary.sent})` }
      }

      case 'quoroom_wallet_send': {
        return { content: 'Wallet send requires on-chain transaction — use the MCP tool quoroom_wallet_send with encryptionKey, or ask the keeper to send funds.', isError: true }
      }

      case 'quoroom_wallet_history': {
        const wallet = queries.getWalletByRoom(db, roomId)
        if (!wallet) return { content: 'No wallet found for this room.', isError: true }
        const limit = Math.min(Number(args.limit) || 10, 50)
        const txs = queries.listWalletTransactions(db, wallet.id, limit)
        if (txs.length === 0) return { content: 'No transactions yet.' }
        const lines = txs.map(tx => `[${tx.type}] ${tx.amount} USDC — ${tx.description ?? ''} (${tx.status})`).join('\n')
        return { content: lines }
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error in ${toolName}: ${message}`, isError: true }
  }
}

// ─── Queen → Keeper external delivery ───────────────────────────────────────

async function deliverQueenMessage(db: Database.Database, roomId: number, question: string): Promise<string> {
  try {
    const cloudApiBase = (process.env.QUOROOM_CLOUD_API ?? 'https://quoroom.ai/api').replace(/\/+$/, '')
    const room = queries.getRoom(db, roomId)
    if (!room) return ''

    const queenNickname = room.queenNickname
    if (!queenNickname) return ''

    const keeperEmail = queries.getSetting(db, 'contact_email')
    const emailVerifiedAt = queries.getSetting(db, 'contact_email_verified_at')
    const telegramId = queries.getSetting(db, 'contact_telegram_id')
    const telegramVerifiedAt = queries.getSetting(db, 'contact_telegram_verified_at')
    const keeperUserNumberRaw = queries.getSetting(db, 'keeper_user_number')
    const keeperUserNumber = keeperUserNumberRaw && /^\d{5,6}$/.test(keeperUserNumberRaw)
      ? Number(keeperUserNumberRaw) : null

    const hasEmail = Boolean(keeperEmail && emailVerifiedAt)
    const hasTelegram = Boolean(telegramId && telegramVerifiedAt)

    if (!hasEmail && !hasTelegram) return ''
    if (!keeperUserNumber) return ''

    const { getStoredCloudRoomToken, getRoomCloudId } = await import('./cloud-sync')
    const cloudRoomId = getRoomCloudId(roomId)
    const roomToken = getStoredCloudRoomToken(cloudRoomId)
    if (!roomToken) return ''

    const channels: string[] = []
    if (hasEmail) channels.push('email')
    if (hasTelegram) channels.push('telegram')

    const res = await fetch(`${cloudApiBase}/contacts/queen-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Room-Token': roomToken,
      },
      body: JSON.stringify({
        roomId: cloudRoomId,
        queenNickname,
        userNumber: keeperUserNumber,
        question,
        channels,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return ''

    const data = await res.json() as { email?: string; telegram?: string }
    const parts: string[] = []
    if (data.email === 'sent') parts.push('email ✓')
    else if (data.email === 'failed') parts.push('email ✗')
    if (data.telegram === 'sent') parts.push('telegram ✓')
    else if (data.telegram === 'failed') parts.push('telegram ✗')
    return parts.length > 0 ? `External delivery: ${parts.join(', ')}.` : ''
  } catch {
    return '' // Best-effort — don't block the tool call
  }
}
