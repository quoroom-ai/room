import type Database from 'better-sqlite3'
import type { Goal } from './types'
import * as queries from './db-queries'

export function setRoomObjective(db: Database.Database, roomId: number, description: string): Goal {
  return queries.createGoal(db, roomId, description)
}

export function completeGoal(db: Database.Database, goalId: number): void {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)
  queries.updateGoal(db, goalId, { status: 'completed', progress: 1.0 })
}

// Keep backward-compatible exports for MCP tools that still reference them
export function decomposeGoal(db: Database.Database, goalId: number, subGoalDescriptions: string[]): Goal[] {
  const parent = queries.getGoal(db, goalId)
  if (!parent) throw new Error(`Goal ${goalId} not found`)
  return subGoalDescriptions.map(desc => queries.createGoal(db, parent.roomId, desc, goalId))
}

export function updateGoalProgress(
  db: Database.Database, goalId: number, observation: string,
  metricValue?: number, workerId?: number
) {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)
  return queries.logGoalUpdate(db, goalId, observation, metricValue, workerId)
}

export function abandonGoal(db: Database.Database, goalId: number, reason: string): void {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)
  queries.updateGoal(db, goalId, { status: 'abandoned' })
  queries.logGoalUpdate(db, goalId, `Abandoned: ${reason}`)
}

export interface GoalTreeNode extends Goal {
  children: GoalTreeNode[]
}

export function getGoalTree(db: Database.Database, roomId: number): GoalTreeNode[] {
  const allGoals = queries.listGoals(db, roomId)
  const byParent = new Map<number | null, Goal[]>()
  for (const g of allGoals) {
    const key = g.parentGoalId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(g)
  }
  function buildTree(parentId: number | null): GoalTreeNode[] {
    const children = byParent.get(parentId) ?? []
    return children.map(g => ({ ...g, children: buildTree(g.id) }))
  }
  return buildTree(null)
}
