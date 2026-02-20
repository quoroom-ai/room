import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { performModification, revertModification, getModificationHistory } from '../../shared/self-mod'
import { incrementSkillVersion } from '../../shared/skills'

export function registerSelfModTools(server: McpServer): void {
  server.registerTool(
    'quoroom_self_mod_edit',
    {
      title: 'Self-Modify',
      description: 'Edit a skill or file with safety checks (rate limiting, forbidden patterns, audit logging). '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        workerId: z.number().describe('The worker performing the modification'),
        skillId: z.number().optional().describe('If editing a skill, the skill ID'),
        filePath: z.string().min(1).describe('Path being modified (for audit logging)'),
        newContent: z.string().min(1).max(50000).describe('The new content'),
        reason: z.string().min(1).max(1000).describe('Reason for the modification')
      }
    },
    async ({ roomId, workerId, skillId, filePath, newContent, reason }) => {
      const db = getMcpDatabase()
      try {
        // If editing a skill, update it via the skills system
        if (skillId != null) {
          const skill = queries.getSkill(db, skillId)
          if (!skill) {
            return { content: [{ type: 'text' as const, text: `Skill ${skillId} not found.` }], isError: true }
          }
          const oldHash = simpleHash(skill.content)
          const newHash = simpleHash(newContent)
          queries.updateSkill(db, skillId, { content: newContent })
          incrementSkillVersion(db, skillId)
          performModification(db, roomId, workerId, filePath, oldHash, newHash, reason)
          return { content: [{ type: 'text' as const, text: `Skill "${skill.name}" updated (v${skill.version + 1}).` }] }
        }

        // General file modification audit
        performModification(db, roomId, workerId, filePath, null, simpleHash(newContent), reason)
        return { content: [{ type: 'text' as const, text: `Modification logged: ${reason}` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_self_mod_revert',
    {
      title: 'Revert Modification',
      description: 'Revert a previous self-modification by audit ID. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        auditId: z.number().describe('The audit entry ID to revert')
      }
    },
    async ({ auditId }) => {
      const db = getMcpDatabase()
      try {
        revertModification(db, auditId)
        return { content: [{ type: 'text' as const, text: `Modification #${auditId} reverted.` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_self_mod_history',
    {
      title: 'Self-Mod History',
      description: 'View self-modification audit history for a room.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum entries (default: 50)')
      }
    },
    async ({ roomId, limit }) => {
      const db = getMcpDatabase()
      const history = getModificationHistory(db, roomId, limit ?? 50)
      if (history.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No modifications recorded.' }] }
      }
      const list = history.map(h => ({
        id: h.id, filePath: h.filePath, reason: h.reason,
        reversible: h.reversible, reverted: h.reverted, createdAt: h.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )
}

function simpleHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit int
  }
  return Math.abs(hash).toString(16)
}
