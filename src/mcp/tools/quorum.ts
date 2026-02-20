import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { propose, vote } from '../../shared/quorum'
import type { DecisionType, VoteValue } from '../../shared/types'

export function registerQuorumTools(server: McpServer): void {
  server.registerTool(
    'quoroom_propose',
    {
      title: 'Propose Decision',
      description: 'Create a proposal for the room quorum to vote on. Low-impact decisions may be auto-approved. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        proposerId: z.number().optional().describe('Worker ID of the proposer'),
        proposal: z.string().min(1).max(2000).describe('The proposal text'),
        decisionType: z.enum(['strategy', 'resource', 'personnel', 'rule_change', 'low_impact'])
          .describe('Type of decision: strategy, resource, personnel, rule_change, or low_impact')
      }
    },
    async ({ roomId, proposerId, proposal, decisionType }) => {
      const db = getMcpDatabase()
      try {
        const decision = propose(db, {
          roomId, proposerId: proposerId ?? null,
          proposal, decisionType: decisionType as DecisionType
        })
        if (decision.status === 'approved') {
          return { content: [{ type: 'text' as const, text: `Proposal auto-approved: "${proposal}"` }] }
        }
        return { content: [{ type: 'text' as const, text: `Proposal #${decision.id} created: "${proposal}" (voting open, ${decision.threshold} threshold)` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_vote',
    {
      title: 'Cast Vote',
      description: 'Cast a vote on a pending quorum decision. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        decisionId: z.number().describe('The decision ID to vote on'),
        workerId: z.number().describe('The worker ID casting the vote'),
        vote: z.enum(['yes', 'no', 'abstain']).describe('Vote: yes, no, or abstain'),
        reasoning: z.string().max(1000).optional().describe('Reasoning for the vote')
      }
    },
    async ({ decisionId, workerId, vote: voteValue, reasoning }) => {
      const db = getMcpDatabase()
      try {
        vote(db, decisionId, workerId, voteValue as VoteValue, reasoning)
        const decision = queries.getDecision(db, decisionId)
        if (decision && decision.status !== 'voting') {
          return { content: [{ type: 'text' as const, text: `Vote cast. Decision resolved: ${decision.status} (${decision.result})` }] }
        }
        return { content: [{ type: 'text' as const, text: `Vote "${voteValue}" cast on decision #${decisionId}.` }] }
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
        status: z.enum(['voting', 'approved', 'rejected', 'vetoed', 'expired']).optional().describe('Filter by status')
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
        status: d.status, result: d.result, threshold: d.threshold, createdAt: d.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_decision_detail',
    {
      title: 'Decision Detail',
      description: 'Get a decision with all its votes.',
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
      const detail = {
        ...decision,
        votes: votes.map(v => ({ workerId: v.workerId, vote: v.vote, reasoning: v.reasoning, createdAt: v.createdAt }))
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] }
    }
  )
}
