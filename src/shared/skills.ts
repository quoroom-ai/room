import type Database from 'better-sqlite3'
import type { Skill } from './types'
import * as queries from './db-queries'

const MAX_ACTIVE_SKILLS_PER_CYCLE = 8
const MAX_SKILL_CONTEXT_CHARS = 6000

export function loadSkillsForAgent(db: Database.Database, roomId: number, contextText: string): string {
  const skills = queries.getActiveSkillsForContext(db, roomId, contextText)
  if (skills.length === 0) return ''

  const sections: string[] = []
  let used = 0

  for (const skill of skills.slice(0, MAX_ACTIVE_SKILLS_PER_CYCLE)) {
    const prefix = sections.length > 0 ? '\n\n---\n\n' : ''
    const full = `${prefix}## Skill: ${skill.name}\n\n${skill.content}`
    const remaining = MAX_SKILL_CONTEXT_CHARS - used
    if (remaining <= 0) break

    if (full.length <= remaining) {
      sections.push(full)
      used += full.length
      continue
    }

    const clipped = full.slice(0, Math.max(0, remaining - 32)).trimEnd()
    if (clipped) {
      sections.push(`${clipped}\n\n[truncated for cycle context]`)
    }
    break
  }

  return sections.join('')
}

export function createAgentSkill(
  db: Database.Database, roomId: number, workerId: number,
  name: string, content: string, activationContext?: string[]
): Skill {
  return queries.createSkill(db, roomId, name, content, {
    activationContext,
    agentCreated: true,
    createdByWorkerId: workerId
  })
}

export function incrementSkillVersion(db: Database.Database, skillId: number): void {
  const skill = queries.getSkill(db, skillId)
  if (!skill) throw new Error(`Skill ${skillId} not found`)
  queries.updateSkill(db, skillId, { version: skill.version + 1 })
}
