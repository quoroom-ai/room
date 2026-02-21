import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { propose, tally } from '../../shared/quorum'

export function registerInboxTools(server: McpServer): void {
  server.registerTool(
    'quoroom_inbox_send_keeper',
    {
      title: 'Send Message to Keeper',
      description: 'Send a message/request to the keeper (creates an escalation). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        fromAgentId: z.number().describe('Worker ID sending the message'),
        question: z.string().min(1).describe('Message content / question for keeper'),
        toAgentId: z.number().optional().describe('Target worker ID (omit for keeper)')
      }
    },
    async ({ roomId, fromAgentId, question, toAgentId }) => {
      const db = getMcpDatabase()
      try {
        const escalation = queries.createEscalation(db, roomId, fromAgentId, question, toAgentId)
        return { content: [{ type: 'text' as const, text: `Message sent to keeper (id: ${escalation.id}).` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_inbox_send_room',
    {
      title: 'Send Message to Another Room',
      description: 'Send an inter-room message (outbound) immediately. '
        + 'A quorum proposal is logged as non-blocking audit (best effort). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('Your room ID'),
        toRoomId: z.string().describe('Target room ID (cloud room identifier)'),
        subject: z.string().min(1).max(200).describe('Message subject'),
        body: z.string().min(1).describe('Message body')
      }
    },
    async ({ roomId, toRoomId, subject, body }) => {
      const db = getMcpDatabase()
      try {
        const proposalText = `Send message to room ${toRoomId}: "${subject}"`

        // Check if there's already an approved decision for this exact message
        const approvedDecisions = queries.listDecisions(db, roomId, 'approved')
        const alreadyApproved = approvedDecisions.find(d => d.proposal === proposalText)

        // Best-effort quorum audit proposal (non-blocking).
        let auditDecisionId: number | null = null
        let auditError: string | null = null
        if (!alreadyApproved) {
          try {
            const pendingDecisions = queries.listDecisions(db, roomId, 'voting')
            const alreadyPending = pendingDecisions.find(d => d.proposal === proposalText)
            if (!alreadyPending) {
              const decision = propose(db, {
                roomId,
                proposerId: null,
                proposal: proposalText,
                decisionType: 'low_impact',
              })
              if (decision.status === 'voting') {
                // If there are any votes, this may resolve immediately.
                tally(db, decision.id)
              }
              auditDecisionId = decision.id
            } else {
              auditDecisionId = alreadyPending.id
            }
          } catch (e) {
            auditError = (e as Error).message
          }
        }

        // Always send the message (flexible mode).
        const msg = queries.createRoomMessage(db, roomId, 'outbound', subject, body, { toRoomId })
        const auditSuffix = auditDecisionId
          ? ` Quorum audit proposal #${auditDecisionId} logged.`
          : (auditError ? ` Quorum audit skipped: ${auditError}.` : '')
        return { content: [{ type: 'text' as const, text: `Message sent to room ${toRoomId} (id: ${msg.id}).${auditSuffix}` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_inbox_list',
    {
      title: 'List Inbox Messages',
      description: 'List inter-room messages for this room. Use status filter for unread messages.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        status: z.enum(['unread', 'read', 'replied']).optional().describe('Filter by status')
      }
    },
    async ({ roomId, status }) => {
      const db = getMcpDatabase()
      try {
        const messages = queries.listRoomMessages(db, roomId, status)
        if (messages.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No messages.' }] }
        }
        const text = messages.map(m =>
          `[${m.id}] ${m.direction} | ${m.subject} | ${m.status} | ${m.createdAt}`
        ).join('\n')
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_inbox_reply',
    {
      title: 'Reply to Room Message',
      description: 'Reply to an inter-room message. Creates an outbound reply and marks the original as replied. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        messageId: z.number().describe('ID of the message to reply to'),
        roomId: z.number().describe('Your room ID'),
        body: z.string().min(1).describe('Reply body')
      }
    },
    async ({ messageId, roomId, body }) => {
      const db = getMcpDatabase()
      try {
        const original = queries.getRoomMessage(db, messageId)
        if (!original) return { content: [{ type: 'text' as const, text: 'Message not found.' }], isError: true }

        // Mark original as replied
        queries.replyToRoomMessage(db, messageId)

        // Create outbound reply
        const reply = queries.createRoomMessage(db, roomId, 'outbound',
          `Re: ${original.subject}`, body,
          { toRoomId: original.fromRoomId ?? undefined })

        return { content: [{ type: 'text' as const, text: `Reply sent (id: ${reply.id}).` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )
}
