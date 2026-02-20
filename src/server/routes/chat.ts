import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { executeClaudeCode } from '../../shared/claude-code'

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

    // Execute with queen's system prompt + session continuity
    const result = await executeClaudeCode(message, {
      systemPrompt: queen.systemPrompt,
      resumeSessionId: room.chatSessionId ?? undefined,
      maxTurns: 10,
      timeoutMs: 3 * 60 * 1000, // 3 minutes
    })

    // Extract response text
    const response = result.stdout || result.stderr || 'No response'

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
