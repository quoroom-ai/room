import type { Router } from '../router'
import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'
import { executeAgent } from '../../shared/agent-executor'
import { getModelProvider } from '../../shared/model-provider'
import { eventBus } from '../event-bus'

function resolveClerkApiKey(model: string | null | undefined): string | undefined {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return process.env.OPENAI_API_KEY || undefined
  }
  if (provider === 'anthropic_api') {
    return process.env.ANTHROPIC_API_KEY || undefined
  }
  return undefined
}

/** Build a system-wide context snapshot for the clerk */
function buildClerkContext(db: Database.Database): string {
  const rooms = queries.listRooms(db)
  const activeRooms = rooms.filter(r => r.status !== 'stopped')

  const parts: string[] = []

  // Rooms overview
  if (activeRooms.length > 0) {
    parts.push('## Active Rooms')
    for (const room of activeRooms) {
      const goals = queries.listGoals(db, room.id).filter(g => g.status === 'active' || g.status === 'in_progress')
      const workers = queries.listRoomWorkers(db, room.id)
      parts.push(`- **${room.name}** (id:${room.id}, status:${room.status}, model:${room.workerModel})`)
      if (room.goal) parts.push(`  Objective: ${room.goal}`)
      if (goals.length > 0) parts.push(`  Goals: ${goals.map(g => `${g.description} (${Math.round(g.progress * 100)}%)`).join(', ')}`)
      if (workers.length > 0) parts.push(`  Workers: ${workers.map(w => w.name).join(', ')}`)
    }
  } else {
    parts.push('No active rooms.')
  }

  // Keeper info
  const referralCode = queries.getSetting(db, 'keeper_referral_code')
  const userNumber = queries.getSetting(db, 'keeper_user_number')
  if (referralCode || userNumber) {
    parts.push('\n## Keeper Info')
    if (userNumber) parts.push(`- User number: ${userNumber}`)
    if (referralCode) parts.push(`- Referral code: ${referralCode}`)
  }

  // Recent activity across all rooms
  const recentActivity: string[] = []
  for (const room of activeRooms.slice(0, 5)) {
    const activity = queries.getRoomActivity(db, room.id, 5)
    for (const a of activity) {
      recentActivity.push(`[${room.name}] ${a.eventType}: ${a.summary}`)
    }
  }
  if (recentActivity.length > 0) {
    parts.push('\n## Recent Activity')
    parts.push(recentActivity.slice(0, 15).join('\n'))
  }

  return parts.join('\n')
}

export function registerClerkRoutes(router: Router): void {
  // List clerk messages
  router.get('/api/clerk/messages', (ctx) => {
    const messages = queries.listClerkMessages(ctx.db)
    return { data: messages }
  })

  // Send a message to the clerk and get a response
  router.post('/api/clerk/chat', async (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.message || typeof body.message !== 'string') {
      return { status: 400, error: 'message is required' }
    }

    const message = (body.message as string).trim()
    if (!message) {
      return { status: 400, error: 'message must not be empty' }
    }

    // Ensure clerk worker exists
    const clerk = queries.ensureClerkWorker(ctx.db)
    const model = queries.getSetting(ctx.db, 'clerk_model') || clerk.model || 'claude'

    // Save user message
    queries.insertClerkMessage(ctx.db, 'user', message)

    // Pause commentary
    queries.setSetting(ctx.db, 'clerk_last_user_message_at', new Date().toISOString())
    eventBus.emit('clerk', 'clerk:user_message', { timestamp: Date.now() })

    // Build context
    const context = buildClerkContext(ctx.db)
    const fullPrompt = `## Current System State\n${context}\n\n## Keeper's Message\n${message}`

    const apiKey = resolveClerkApiKey(model)
    const sessionId = queries.getSetting(ctx.db, 'clerk_session_id') || undefined

    const result = await executeAgent({
      model,
      prompt: fullPrompt,
      systemPrompt: clerk.systemPrompt,
      resumeSessionId: sessionId,
      apiKey,
      maxTurns: 10,
      timeoutMs: 3 * 60 * 1000,
    })

    if (result.exitCode !== 0 || result.timedOut) {
      const rawOutput = result.output?.trim()
      let reason: string
      if (result.timedOut) {
        reason = 'Clerk request timed out'
      } else if (rawOutput) {
        reason = rawOutput
      } else {
        reason = `Clerk execution failed (model: ${model}, exit code: ${result.exitCode})`
      }
      return { status: result.timedOut ? 504 : 502, error: reason.slice(0, 500) }
    }

    const response = result.output || 'No response'

    // Save assistant response
    queries.insertClerkMessage(ctx.db, 'assistant', response)

    // Save session for continuity
    if (result.sessionId) {
      queries.setSetting(ctx.db, 'clerk_session_id', result.sessionId)
    }

    const messages = queries.listClerkMessages(ctx.db)
    return { data: { response, messages } }
  })

  // Reset clerk session and messages
  router.post('/api/clerk/reset', (ctx) => {
    queries.clearClerkSession(ctx.db)
    return { data: { ok: true } }
  })

  // Get clerk status
  router.get('/api/clerk/status', (ctx) => {
    const clerkWorkerId = queries.getSetting(ctx.db, 'clerk_worker_id')
    const model = queries.getSetting(ctx.db, 'clerk_model')
    const commentaryEnabled = queries.getSetting(ctx.db, 'clerk_commentary_enabled') !== 'false'

    return {
      data: {
        configured: Boolean(clerkWorkerId) || Boolean(model),
        model: model || null,
        commentaryEnabled,
      }
    }
  })

  // Update clerk settings
  router.put('/api/clerk/settings', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}

    if (body.model !== undefined) {
      queries.setSetting(ctx.db, 'clerk_model', String(body.model))
      // Ensure clerk worker exists and update its model
      const clerk = queries.ensureClerkWorker(ctx.db)
      queries.updateWorker(ctx.db, clerk.id, { model: String(body.model) })
    }

    if (body.commentaryEnabled !== undefined) {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', body.commentaryEnabled ? 'true' : 'false')
    }

    return {
      data: {
        model: queries.getSetting(ctx.db, 'clerk_model') || null,
        commentaryEnabled: queries.getSetting(ctx.db, 'clerk_commentary_enabled') !== 'false',
      }
    }
  })
}
