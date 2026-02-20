import type Database from 'better-sqlite3'
import type { Skill } from './types'
import * as queries from './db-queries'

export function loadSkillsForAgent(db: Database.Database, roomId: number, contextText: string): string {
  const skills = queries.getActiveSkillsForContext(db, roomId, contextText)
  if (skills.length === 0) return ''
  return skills.map(s => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n---\n\n')
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
