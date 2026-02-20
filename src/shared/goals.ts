import type Database from 'better-sqlite3'
import type { Goal, GoalUpdate } from './types'
import * as queries from './db-queries'

export interface GoalTreeNode extends Goal {
  children: GoalTreeNode[]
}

export function setRoomObjective(db: Database.Database, roomId: number, description: string): Goal {
  return queries.createGoal(db, roomId, description)
}

export function decomposeGoal(db: Database.Database, goalId: number, subGoalDescriptions: string[]): Goal[] {
  const parent = queries.getGoal(db, goalId)
  if (!parent) throw new Error(`Goal ${goalId} not found`)
  if (parent.status === 'completed' || parent.status === 'abandoned') {
    throw new Error(`Cannot decompose goal with status '${parent.status}'`)
  }
  // Mark parent as in_progress if still active
  if (parent.status === 'active') {
    queries.updateGoal(db, goalId, { status: 'in_progress' })
  }
  return subGoalDescriptions.map(desc => queries.createGoal(db, parent.roomId, desc, goalId))
}

export function updateGoalProgress(
  db: Database.Database, goalId: number, observation: string,
  metricValue?: number, workerId?: number
): GoalUpdate {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)

  const update = queries.logGoalUpdate(db, goalId, observation, metricValue, workerId)

  // If a metric value is provided and this is a leaf goal, set progress directly
  if (metricValue != null) {
    const subGoals = queries.getSubGoals(db, goalId)
    if (subGoals.length === 0) {
      const clamped = Math.max(0, Math.min(1, metricValue))
      queries.updateGoal(db, goalId, { progress: clamped })
    }
  }

  // Recalculate parent chain
  recalculateParentChain(db, goal.parentGoalId)

  return update
}

export function completeGoal(db: Database.Database, goalId: number): void {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)
  queries.updateGoal(db, goalId, { status: 'completed', progress: 1.0 })
  recalculateParentChain(db, goal.parentGoalId)
}

export function abandonGoal(db: Database.Database, goalId: number, reason: string): void {
  const goal = queries.getGoal(db, goalId)
  if (!goal) throw new Error(`Goal ${goalId} not found`)
  queries.updateGoal(db, goalId, { status: 'abandoned' })
  queries.logGoalUpdate(db, goalId, `Abandoned: ${reason}`)
  recalculateParentChain(db, goal.parentGoalId)
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
    return children.map(g => ({
      ...g,
      children: buildTree(g.id)
    }))
  }

  return buildTree(null)
}

function recalculateParentChain(db: Database.Database, parentGoalId: number | null): void {
  let currentId = parentGoalId
  while (currentId != null) {
    queries.recalculateGoalProgress(db, currentId)
    const parent = queries.getGoal(db, currentId)
    currentId = parent?.parentGoalId ?? null
  }
}
