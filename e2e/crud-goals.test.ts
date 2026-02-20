/**
 * E2E: Full CRUD lifecycle for Goals.
 * Tests list, get, update, delete, sub-goals, progress updates.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Goals — full CRUD + sub-goals + progress updates', async ({ page }) => {
  await injectTestUI(page, 'Goals — Full CRUD Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // Setup: Create room
  const room = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'Goal Test Room', goal: 'Test goal CRUD' }
  })
  const roomId = room.body?.room?.id
  const rootGoalId = room.body?.rootGoal?.id

  // 1. Create sub-goal
  const create = await browserFetch(page, 'POST', `/api/rooms/${roomId}/goals`, {
    token,
    body: { description: 'First sub-goal', parentGoalId: rootGoalId }
  })
  check(create.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/goals`, create.status, {
    id: create.body?.id,
    description: create.body?.description
  }, 201)
  const goalId = create.body?.id

  // 2. Create second sub-goal
  const create2 = await browserFetch(page, 'POST', `/api/rooms/${roomId}/goals`, {
    token,
    body: { description: 'Second sub-goal', parentGoalId: rootGoalId }
  })
  check(create2.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/goals (second)`, create2.status, {
    id: create2.body?.id
  }, 201)

  // 3. List room goals
  const list = await browserFetch(page, 'GET', `/api/rooms/${roomId}/goals`, { token })
  check(list.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/goals`, list.status, {
    count: Array.isArray(list.body) ? list.body.length : 'not array'
  }, 200)

  // 4. GET individual goal
  const get = await browserFetch(page, 'GET', `/api/goals/${goalId}`, { token })
  check(get.status, 200)
  await addResult(page, `GET /api/goals/${goalId}`, get.status, {
    id: get.body?.id,
    description: get.body?.description,
    status: get.body?.status
  }, 200)

  await page.screenshot({ path: 'e2e/screenshots/crud-goals-01.png', fullPage: true })

  // 5. PATCH update goal
  const patch = await browserFetch(page, 'PATCH', `/api/goals/${goalId}`, {
    token,
    body: { description: 'Updated sub-goal description', status: 'in_progress' }
  })
  check(patch.status, 200)
  await addResult(page, `PATCH /api/goals/${goalId}`, patch.status, patch.body, 200)

  // 6. Verify update
  const getUpdated = await browserFetch(page, 'GET', `/api/goals/${goalId}`, { token })
  const descOk = getUpdated.body?.description === 'Updated sub-goal description'
  if (descOk) passed++; else failed++
  await addResult(page, `GET /api/goals/${goalId} (verify update)`, getUpdated.status, {
    description: getUpdated.body?.description,
    correct: descOk
  }, 200)

  // 7. GET sub-goals of root
  const subgoals = await browserFetch(page, 'GET', `/api/goals/${rootGoalId}/subgoals`, { token })
  check(subgoals.status, 200)
  await addResult(page, `GET /api/goals/${rootGoalId}/subgoals`, subgoals.status, {
    count: Array.isArray(subgoals.body) ? subgoals.body.length : 'not array'
  }, 200)

  // 8. Add progress update
  const addUpdate = await browserFetch(page, 'POST', `/api/goals/${goalId}/updates`, {
    token,
    body: { observation: 'Making progress on sub-goal', metricValue: 50 }
  })
  check(addUpdate.status, 201)
  await addResult(page, `POST /api/goals/${goalId}/updates`, addUpdate.status, addUpdate.body, 201)

  // 9. GET progress updates
  const getUpdates = await browserFetch(page, 'GET', `/api/goals/${goalId}/updates`, { token })
  check(getUpdates.status, 200)
  await addResult(page, `GET /api/goals/${goalId}/updates`, getUpdates.status, {
    count: Array.isArray(getUpdates.body) ? getUpdates.body.length : 'not array'
  }, 200)

  // 10. DELETE goal
  const del = await browserFetch(page, 'DELETE', `/api/goals/${goalId}`, { token })
  check(del.status, 200)
  await addResult(page, `DELETE /api/goals/${goalId}`, del.status, del.body, 200)

  // 11. GET deleted goal → 404
  const getDeleted = await browserFetch(page, 'GET', `/api/goals/${goalId}`, { token })
  check(getDeleted.status, 404)
  await addResult(page, `GET /api/goals/${goalId} (after delete)`, getDeleted.status, getDeleted.body, 404)

  // Cleanup
  await browserFetch(page, 'DELETE', `/api/rooms/${roomId}`, { token })

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/crud-goals-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
