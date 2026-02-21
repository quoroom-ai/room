import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { createAgentSkill, incrementSkillVersion } from '../../shared/skills'
import { performModification } from '../../shared/self-mod'

export function registerSkillTools(server: McpServer): void {
  server.registerTool(
    'quoroom_create_skill',
    {
      title: 'Create Skill',
      description: 'Create a new skill for agents in a room. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('The room ID'),
        name: z.string().min(1).max(200).describe('Skill name'),
        content: z.string().min(1).max(50000).describe('Skill content (instructions, knowledge, etc.)'),
        activationContext: z.array(z.string()).optional()
          .describe('Keywords that trigger this skill (omit for manual-only)'),
        autoActivate: z.boolean().optional().describe('Auto-activate when context matches (default: true)'),
        workerId: z.number().optional().describe('Worker creating this skill (marks as agent-created)')
      }
    },
    async ({ roomId, name, content, activationContext, autoActivate, workerId }) => {
      const db = getMcpDatabase()
      try {
        if (workerId != null) {
          const skill = createAgentSkill(db, roomId, workerId, name, content, activationContext)
          if (autoActivate === false) {
            queries.updateSkill(db, skill.id, { autoActivate: false })
          }
          return { content: [{ type: 'text' as const, text: `Skill "${name}" created (id: ${skill.id}).` }] }
        }
        const skill = queries.createSkill(db, roomId, name, content, {
          activationContext,
          autoActivate: autoActivate ?? true
        })
        return { content: [{ type: 'text' as const, text: `Skill "${name}" created (id: ${skill.id}).` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_edit_skill',
    {
      title: 'Edit Skill',
      description: 'Update a skill\'s content or metadata. Increments the version. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        skillId: z.number().describe('The skill ID'),
        roomId: z.number().optional().describe('Optional room scope guard (recommended for queen flows)'),
        workerId: z.number().optional().describe('Worker performing this change (for self-mod rate limiting/audit attribution)'),
        filePath: z.string().optional().describe('Optional skill file path label for audit trail'),
        reason: z.string().max(1000).optional().describe('Optional reason for audit trail'),
        content: z.string().min(1).max(50000).optional().describe('New skill content'),
        name: z.string().min(1).max(200).optional().describe('New skill name'),
        activationContext: z.array(z.string()).optional().describe('New activation keywords')
      }
    },
    async ({ skillId, roomId, workerId, filePath, reason, content, name, activationContext }) => {
      const db = getMcpDatabase()
      try {
        const skill = queries.getSkill(db, skillId)
        if (!skill) {
          return { content: [{ type: 'text' as const, text: `Skill ${skillId} not found.` }], isError: true }
        }
        if (roomId != null && skill.roomId !== roomId) {
          return { content: [{ type: 'text' as const, text: `Skill ${skillId} does not belong to room ${roomId}.` }], isError: true }
        }
        if (workerId != null) {
          const worker = queries.getWorker(db, workerId)
          const effectiveRoomId = roomId ?? skill.roomId
          if (!worker || (effectiveRoomId != null && worker.roomId !== effectiveRoomId)) {
            return {
              content: [{
                type: 'text' as const,
                text: `Worker ${workerId} is not allowed to edit skill ${skillId} in this room.`
              }],
              isError: true
            }
          }
        }

        const updates: Record<string, unknown> = {}
        if (content != null) updates.content = content
        if (name != null) updates.name = name
        if (activationContext != null) updates.activationContext = activationContext
        if (Object.keys(updates).length > 0) {
          const oldHash = content != null ? simpleHash(skill.content) : null
          const newHash = content != null ? simpleHash(content) : null
          const auditFilePath = filePath ?? `/skills/${skillId}`
          const auditReason = reason ?? 'Skill updated via quoroom_edit_skill'
          const audit = performModification(
            db,
            skill.roomId ?? roomId ?? null,
            workerId ?? null,
            auditFilePath,
            oldHash,
            newHash,
            auditReason
          )
          queries.updateSkill(db, skillId, updates)
          incrementSkillVersion(db, skillId)
          if (content != null) {
            queries.saveSelfModSnapshot(db, audit.id, 'skill', skillId, skill.content, content)
          }
        }
        return { content: [{ type: 'text' as const, text: `Skill "${skill.name}" updated (v${skill.version + 1}).` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true }
      }
    }
  )

  server.registerTool(
    'quoroom_list_skills',
    {
      title: 'List Skills',
      description: 'List all skills for a room.',
      inputSchema: {
        roomId: z.number().describe('The room ID')
      }
    },
    async ({ roomId }) => {
      const db = getMcpDatabase()
      const skills = queries.listSkills(db, roomId)
      if (skills.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No skills created.' }] }
      }
      const list = skills.map(s => ({
        id: s.id, name: s.name, version: s.version,
        autoActivate: s.autoActivate, agentCreated: s.agentCreated,
        activationContext: s.activationContext
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'quoroom_activate_skill',
    {
      title: 'Activate Skill',
      description: 'Enable auto-activation for a skill. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        skillId: z.number().describe('The skill ID to activate')
      }
    },
    async ({ skillId }) => {
      const db = getMcpDatabase()
      const skill = queries.getSkill(db, skillId)
      if (!skill) {
        return { content: [{ type: 'text' as const, text: `Skill ${skillId} not found.` }], isError: true }
      }
      queries.updateSkill(db, skillId, { autoActivate: true })
      return { content: [{ type: 'text' as const, text: `Skill "${skill.name}" activated.` }] }
    }
  )

  server.registerTool(
    'quoroom_deactivate_skill',
    {
      title: 'Deactivate Skill',
      description: 'Disable auto-activation for a skill. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        skillId: z.number().describe('The skill ID to deactivate')
      }
    },
    async ({ skillId }) => {
      const db = getMcpDatabase()
      const skill = queries.getSkill(db, skillId)
      if (!skill) {
        return { content: [{ type: 'text' as const, text: `Skill ${skillId} not found.` }], isError: true }
      }
      queries.updateSkill(db, skillId, { autoActivate: false })
      return { content: [{ type: 'text' as const, text: `Skill "${skill.name}" deactivated.` }] }
    }
  )

  server.registerTool(
    'quoroom_delete_skill',
    {
      title: 'Delete Skill',
      description: 'Permanently delete a skill. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        skillId: z.number().describe('The skill ID to delete')
      }
    },
    async ({ skillId }) => {
      const db = getMcpDatabase()
      const skill = queries.getSkill(db, skillId)
      if (!skill) {
        return { content: [{ type: 'text' as const, text: `Skill ${skillId} not found.` }], isError: true }
      }
      queries.deleteSkill(db, skillId)
      return { content: [{ type: 'text' as const, text: `Skill "${skill.name}" deleted.` }] }
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
