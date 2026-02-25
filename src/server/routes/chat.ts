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

    // Execute with queen's system prompt + session continuity
    const namePrefix = room.queenNickname ? `Your name is ${room.queenNickname}.\n\n` : ''
    const result = await executeAgent({
      model,
      prompt: message,
      systemPrompt: namePrefix + queen.systemPrompt,
      resumeSessionId: room.chatSessionId ?? undefined,
      apiKey,
      maxTurns: 10,
      timeoutMs: 3 * 60 * 1000, // 3 minutes
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
