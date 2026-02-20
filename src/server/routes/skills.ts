import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerSkillRoutes(router: Router): void {
  router.post('/api/skills', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.roomId || typeof body.roomId !== 'number') {
      return { status: 400, error: 'roomId is required' }
    }
    if (!body.name || typeof body.name !== 'string') {
      return { status: 400, error: 'name is required' }
    }
    if (!body.content || typeof body.content !== 'string') {
      return { status: 400, error: 'content is required' }
    }

    const skill = queries.createSkill(ctx.db, body.roomId, body.name, body.content, {
      autoActivate: body.autoActivate as boolean | undefined,
      activationContext: body.activationContext as string[] | undefined,
      agentCreated: body.agentCreated as boolean | undefined
    })
    eventBus.emit(`room:${body.roomId}`, 'skill:created', skill)
    return { status: 201, data: skill }
  })

  router.get('/api/skills', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    const skills = queries.listSkills(ctx.db, roomId)
    return { data: skills }
  })

  router.get('/api/skills/:id', (ctx) => {
    const skill = queries.getSkill(ctx.db, Number(ctx.params.id))
    if (!skill) return { status: 404, error: 'Skill not found' }
    return { data: skill }
  })

  router.patch('/api/skills/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const skill = queries.getSkill(ctx.db, id)
    if (!skill) return { status: 404, error: 'Skill not found' }

    const body = ctx.body as Record<string, unknown> || {}
    queries.updateSkill(ctx.db, id, body)
    const updated = queries.getSkill(ctx.db, id)
    eventBus.emit(`room:${skill.roomId}`, 'skill:updated', updated)
    return { data: updated }
  })

  router.delete('/api/skills/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const skill = queries.getSkill(ctx.db, id)
    if (!skill) return { status: 404, error: 'Skill not found' }

    queries.deleteSkill(ctx.db, id)
    eventBus.emit(`room:${skill.roomId}`, 'skill:deleted', { id })
    return { data: { ok: true } }
  })
}
