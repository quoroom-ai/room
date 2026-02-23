import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { propose, vote } from './quorum'
import { updateGoalProgress, decomposeGoal, completeGoal, abandonGoal, setRoomObjective } from './goals'
import type { DecisionType, VoteValue } from './types'

// ─── Ollama tool definition format (compatible with OpenAI format) ──────────

export interface OllamaToolProperty {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
}

export interface OllamaToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, OllamaToolProperty>
      required?: string[]
    }
  }
}

// ─── All queen tool definitions ─────────────────────────────────────────────

export const QUEEN_TOOL_DEFINITIONS: OllamaToolDef[] = [
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
      description: 'Create a new named agent worker with a system prompt that defines its personality and capabilities.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the worker (e.g. "Research Agent", "Code Reviewer")' },
          systemPrompt: { type: 'string', description: 'The system prompt defining this worker\'s personality, role, and constraints' },
          role: { type: 'string', description: 'Optional role/function title (e.g. "Chief of Staff")' },
          description: { type: 'string', description: 'Optional short description of what this worker does' }
        },
        required: ['name', 'systemPrompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'quoroom_update_worker',
      description: 'Update an existing worker\'s name, role, system prompt, or description.',
      parameters: {
        type: 'object',
        properties: {
          workerId: { type: 'number', description: 'The worker ID to update' },
          name: { type: 'string', description: 'New name' },
          role: { type: 'string', description: 'New role/function title' },
          systemPrompt: { type: 'string', description: 'New system prompt' },
          description: { type: 'string', description: 'New description' }
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
            description: 'Max tool-call turns per queen cycle (1–20)'
          }
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
        const goalId = Number(args.goalId)
        const observation = String(args.observation ?? '')
        const metricValue = args.metricValue != null ? Number(args.metricValue) : undefined
        updateGoalProgress(db, goalId, observation, metricValue, workerId)
        const goal = queries.getGoal(db, goalId)
        const pct = Math.round((goal?.progress ?? 0) * 100)
        return { content: `Progress logged on goal #${goalId}. Now at ${pct}%.` }
      }

      case 'quoroom_create_subgoal': {
        const goalId = Number(args.goalId)
        const raw = args.descriptions
        const descriptions = Array.isArray(raw) ? raw.map(String) : [String(raw)]
        const subGoals = decomposeGoal(db, goalId, descriptions)
        return { content: `Created ${subGoals.length} sub-goal(s) under goal #${goalId}.` }
      }

      case 'quoroom_complete_goal': {
        const goalId = Number(args.goalId)
        completeGoal(db, goalId)
        return { content: `Goal #${goalId} marked as completed.` }
      }

      case 'quoroom_abandon_goal': {
        const goalId = Number(args.goalId)
        const reason = String(args.reason ?? 'No reason given')
        abandonGoal(db, goalId, reason)
        return { content: `Goal #${goalId} abandoned: ${reason}` }
      }

      // ── Quorum ───────────────────────────────────────────────────────
      case 'quoroom_propose': {
        const decision = propose(db, {
          roomId,
          proposerId: workerId,
          proposal: String(args.proposal ?? ''),
          decisionType: String(args.decisionType ?? 'low_impact') as DecisionType
        })
        if (decision.status === 'approved') {
          return { content: `Proposal auto-approved: "${args.proposal}"` }
        }
        return { content: `Proposal #${decision.id} created: "${args.proposal}" (${decision.threshold} threshold, voting open)` }
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
        const name = String(args.name ?? '')
        const systemPrompt = String(args.systemPrompt ?? '')
        const role = args.role ? String(args.role) : undefined
        const description = args.description ? String(args.description) : undefined
        queries.createWorker(db, { name, role, systemPrompt, description, roomId })
        return { content: `Created worker "${name}"${role ? ` (${role})` : ''}.` }
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
        return { content: `Question sent to keeper (escalation #${escalation.id}).` }
      }

      // ── Room config ──────────────────────────────────────────────────
      case 'quoroom_configure_room': {
        const updates: Parameters<typeof queries.updateRoom>[2] = {}
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(10_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(20, Number(args.queenMaxTurns)))
        if (Object.keys(updates).length > 0) {
          queries.updateRoom(db, roomId, updates)
          return { content: `Room configured: ${JSON.stringify(updates)}` }
        }
        return { content: 'No changes applied.' }
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error in ${toolName}: ${message}`, isError: true }
  }
}
