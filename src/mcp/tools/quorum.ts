import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { announce, object, vote } from '../../shared/quorum'
import type { DecisionType, VoteValue } from '../../shared/types'
import { nudgeRoomWorkers } from '../nudge'

export function registerQuorumTools(server: McpServer): void {
  server.registerTool(
    'quoroom_propose',
    {
      title: 'Announce Decision',
      description: 'Announce a decision for the room. Becomes effective after 10 min unless a worker objects. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        proposerId: z.number().optional().describe('Worker ID of the proposer'),
        proposal: z.string().min(1).max(2000).describe('The decision text.'),
        decisionType: z.enum(['strategy', 'resource', 'personnel', 'rule_change', 'low_impact'])
          .describe('Type of decision')
      }
    },
    async ({ roomId, proposerId, proposal, decisionType }) => {
      const db = getMcpDatabase()
      try {
        const decision = announce(db, {
          roomId, proposerId: proposerId ?? null,
          proposal, decisionType: decisionType as DecisionType
        })
        if (decision.status === 'approved') {
          return { content: [{ type: 'text' as const, text: `Decision auto-approved: "${proposal}"` }] }
        }
        nudgeRoomWorkers(roomId, proposerId ?? 0)
        return { content: [{ type: 'text' as const, text: `Decision #${decision.id} announced: "${proposal}". Effective in 10 min unless objected.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_vote',
    {
      title: 'Object to Decision',
      description: 'Object to an announced decision (vote "no" to object), or acknowledge it. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        decisionId: z.number().describe('The decision ID'),
        workerId: z.number().describe('The worker ID'),
        vote: z.enum(['yes', 'no', 'abstain']).describe('Vote: "no" to object, "yes" to acknowledge'),
        reasoning: z.string().max(1000).optional().describe('Reasoning')
      }
    },
    async ({ decisionId, workerId, vote: voteValue, reasoning }) => {
      const db = getMcpDatabase()
      try {
        const decision = queries.getDecision(db, decisionId)
        if (!decision) {
          return { content: [{ type: 'text' as const, text: `Decision ${decisionId} not found.` }], isError: true }
        }
        if (decision.status === 'announced' && voteValue === 'no') {
          const result = object(db, decisionId, workerId, reasoning ?? 'Objected')
          return { content: [{ type: 'text' as const, text: `Objection recorded on decision #${decisionId}. Status: ${result.status}` }] }
        }
        if (decision.status === 'voting') {
          vote(db, decisionId, workerId, voteValue as VoteValue, reasoning)
          const updated = queries.getDecision(db, decisionId)
          if (updated && updated.status !== 'voting') {
            return { content: [{ type: 'text' as const, text: `Vote cast. Decision resolved: ${updated.status}` }] }
          }
          return { content: [{ type: 'text' as const, text: `Vote "${voteValue}" cast on decision #${decisionId}.` }] }
        }
        return { content: [{ type: 'text' as const, text: `Acknowledged on decision #${decisionId}.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_list_decisions',
    {
      title: 'List Decisions',
      description: 'List quorum decisions for a room, optionally filtered by status.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        status: z.enum(['voting', 'approved', 'rejected', 'vetoed', 'expired', 'announced', 'objected', 'effective']).optional().describe('Filter by status')
      }
    },
    async ({ roomId, status }) => {
      const db = getMcpDatabase()
      const decisions = queries.listDecisions(db, roomId, status as Parameters<typeof queries.listDecisions>[2])
      if (decisions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No decisions found.' }] }
      }
      const list = decisions.map(d => ({
        id: d.id, proposal: d.proposal, decisionType: d.decisionType,
        status: d.status, result: d.result, effectiveAt: d.effectiveAt, createdAt: d.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_decision_detail',
    {
      title: 'Decision Detail',
      description: 'Get a decision with details.',
      inputSchema: {
        id: z.number().describe('The decision ID')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const decision = queries.getDecision(db, id)
      if (!decision) {
        return { content: [{ type: 'text' as const, text: `Decision ${id} not found.` }], isError: true }
      }
      const votes = queries.getVotes(db, id)
      const detail = { ...decision, votes: votes.map(v => ({ workerId: v.workerId, vote: v.vote, reasoning: v.reasoning })) }
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] }
    }
  )

}
