import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { executeAgent } from '../../shared/agent-executor'
import { resolveApiKeyForModel } from '../../shared/model-provider'

export function registerChatRoutes(router: Router): void {
  // List chat messages for a room
  router.get('/api/rooms/:roomId/chat/messages', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    const messages = queries.listChatMessages(ctx.db, roomId)
    return { data: messages }
  })

  // Send a message to the queen and get a response
  router.post('/api/rooms/:roomId/chat', async (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    if (!room.queenWorkerId) {
      return { status: 400, error: 'Room has no queen worker' }
    }

    const queen = queries.getWorker(ctx.db, room.queenWorkerId)
    if (!queen) {
      return { status: 400, error: 'Queen worker not found' }
    }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.message || typeof body.message !== 'string') {
      return { status: 400, error: 'message is required' }
    }

    const message = body.message.trim()
    if (!message) {
      return { status: 400, error: 'message must not be empty' }
    }

    // Save user message
    queries.insertChatMessage(ctx.db, roomId, 'user', message)

    const model = queen.model ?? 'claude'
    const apiKey = resolveApiKeyForModel(ctx.db, roomId, model)

    // Build a chat-oriented system prompt: keep queen identity but instruct
    // conversational behaviour instead of autonomous cycle mode.
    const namePrefix = room.queenNickname ? `Your name is ${room.queenNickname}. ` : ''
    const chatSystemPrompt = `${namePrefix}You are the queen of the "${room.name}" room. The keeper (your human) is chatting with you.

RULES FOR CHAT:
- Be concise — 2-4 sentences unless the keeper asks for detail.
- Answer what was asked. Do NOT dump a full status report unless requested.
- Do NOT run tools or take autonomous actions unless the keeper asks you to.
- Be friendly and natural, not formal or robotic.
- If the keeper greets you, greet back briefly and ask what they need.

You know your room's context: goal is "${room.goal || 'not set yet'}".`

    const result = await executeAgent({
      model,
      prompt: message,
      systemPrompt: chatSystemPrompt,
      resumeSessionId: room.chatSessionId ?? undefined,
      apiKey,
      maxTurns: 10,
      timeoutMs: 3 * 60 * 1000, // 3 minutes
      permissionMode: 'bypassPermissions',
    })

    if (result.exitCode !== 0 || result.timedOut) {
      const rawOutput = result.output?.trim()
      let reason: string
      if (result.timedOut) {
        reason = 'Chat request timed out'
      } else if (rawOutput) {
        reason = rawOutput
      } else {
        reason = `Chat execution failed (model: ${model}, exit code: ${result.exitCode})`
      }
      return { status: result.timedOut ? 504 : 502, error: reason.slice(0, 500) }
    }

    // Extract response text
    const response = result.output || 'No response'

    // Save assistant response
    queries.insertChatMessage(ctx.db, roomId, 'assistant', response)

    // Save session ID for continuity
    if (result.sessionId) {
      queries.setChatSessionId(ctx.db, roomId, result.sessionId)
    }

    const messages = queries.listChatMessages(ctx.db, roomId)
    return { data: { response, messages } }
  })

  // Reset chat session and messages
  router.post('/api/rooms/:roomId/chat/reset', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }

    queries.clearChatSession(ctx.db, roomId)
    return { data: { ok: true } }
  })
}
