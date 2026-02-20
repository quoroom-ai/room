import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { loadSkillsForAgent, createAgentSkill, incrementSkillVersion } from '../skills'

let db: Database.Database
let roomId: number
let workerId: number

beforeEach(() => {
  db = initTestDb()
  const room = queries.createRoom(db, 'Test Room', 'Goal')
  roomId = room.id
  const worker = queries.createWorker(db, { name: 'Queen', systemPrompt: 'You are the queen.', roomId })
  workerId = worker.id
})

describe('createAgentSkill', () => {
  it('creates a skill with agent_created flag', () => {
    const skill = createAgentSkill(db, roomId, workerId, 'Web Scraping', 'Scrape websites efficiently.', ['scraping', 'crawling'])
    expect(skill.name).toBe('Web Scraping')
    expect(skill.content).toBe('Scrape websites efficiently.')
    expect(skill.agentCreated).toBe(true)
    expect(skill.createdByWorkerId).toBe(workerId)
    expect(skill.activationContext).toEqual(['scraping', 'crawling'])
    expect(skill.version).toBe(1)
  })

  it('creates a skill without activation context', () => {
    const skill = createAgentSkill(db, roomId, workerId, 'General', 'General instructions.')
    expect(skill.activationContext).toBeNull()
  })
})

describe('loadSkillsForAgent', () => {
  it('returns empty string when no skills', () => {
    expect(loadSkillsForAgent(db, roomId, 'any context')).toBe('')
  })

  it('loads auto-activated skills matching context', () => {
    queries.createSkill(db, roomId, 'Scraping', 'Use puppeteer.', {
      activationContext: ['scraping', 'crawling'],
      autoActivate: true
    })
    queries.createSkill(db, roomId, 'Marketing', 'SEO tips.', {
      activationContext: ['marketing', 'seo'],
      autoActivate: true
    })

    const result = loadSkillsForAgent(db, roomId, 'I need to do web scraping')
    expect(result).toContain('Scraping')
    expect(result).toContain('Use puppeteer.')
    expect(result).not.toContain('Marketing')
  })

  it('loads skills with no activation context (always match)', () => {
    queries.createSkill(db, roomId, 'General', 'Always active.', {
      autoActivate: true
    })
    const result = loadSkillsForAgent(db, roomId, 'anything')
    expect(result).toContain('General')
  })

  it('ignores non-auto-activate skills', () => {
    queries.createSkill(db, roomId, 'Manual', 'Manual skill.', {
      activationContext: ['manual'],
      autoActivate: false
    })
    expect(loadSkillsForAgent(db, roomId, 'manual task')).toBe('')
  })

  it('matches case-insensitively', () => {
    queries.createSkill(db, roomId, 'Coding', 'Write code.', {
      activationContext: ['CODING'],
      autoActivate: true
    })
    expect(loadSkillsForAgent(db, roomId, 'coding task')).toContain('Coding')
  })
})

describe('incrementSkillVersion', () => {
  it('increments version number', () => {
    const skill = createAgentSkill(db, roomId, workerId, 'Test', 'Content')
    expect(skill.version).toBe(1)

    incrementSkillVersion(db, skill.id)
    const updated = queries.getSkill(db, skill.id)!
    expect(updated.version).toBe(2)

    incrementSkillVersion(db, skill.id)
    expect(queries.getSkill(db, skill.id)!.version).toBe(3)
  })

  it('throws for nonexistent skill', () => {
    expect(() => incrementSkillVersion(db, 999)).toThrow('Skill 999 not found')
  })
})
