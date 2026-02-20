/**
 * E2E: Full CRUD lifecycle for Tasks.
 * Tests list, get, update, delete, pause, resume, run history.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Tasks — full CRUD + pause/resume + runs', async ({ page }) => {
  await injectTestUI(page, 'Tasks — Full CRUD Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // 1. Create task
  const create = await browserFetch(page, 'POST', '/api/tasks', {
    token,
    body: { prompt: 'E2E task lifecycle test', name: 'Lifecycle Task' }
  })
  check(create.status, 201)
  await addResult(page, 'POST /api/tasks', create.status, {
    id: create.body?.id,
    name: create.body?.name,
    status: create.body?.status
  }, 201)
  const taskId = create.body?.id

  // 2. Create second task
  const create2 = await browserFetch(page, 'POST', '/api/tasks', {
    token,
    body: { prompt: 'Second E2E task', name: 'Second Task' }
  })
  check(create2.status, 201)
  await addResult(page, 'POST /api/tasks (second)', create2.status, {
    id: create2.body?.id
  }, 201)

  // 3. List tasks
  const list = await browserFetch(page, 'GET', '/api/tasks', { token })
  check(list.status, 200)
  await addResult(page, 'GET /api/tasks', list.status, {
    count: Array.isArray(list.body) ? list.body.length : 'not array'
  }, 200)

  // 4. GET individual task
  const get = await browserFetch(page, 'GET', `/api/tasks/${taskId}`, { token })
  check(get.status, 200)
  await addResult(page, `GET /api/tasks/${taskId}`, get.status, {
    id: get.body?.id,
    name: get.body?.name,
    prompt: get.body?.prompt?.slice(0, 30),
    status: get.body?.status
  }, 200)

  await page.screenshot({ path: 'e2e/screenshots/crud-tasks-01.png', fullPage: true })

  // 5. PATCH update task
  const patch = await browserFetch(page, 'PATCH', `/api/tasks/${taskId}`, {
    token,
    body: { name: 'Updated Lifecycle Task', description: 'Updated description' }
  })
  check(patch.status, 200)
  await addResult(page, `PATCH /api/tasks/${taskId}`, patch.status, patch.body, 200)

  // 6. Verify update
  const getUpdated = await browserFetch(page, 'GET', `/api/tasks/${taskId}`, { token })
  const nameOk = getUpdated.body?.name === 'Updated Lifecycle Task'
  if (nameOk) passed++; else failed++
  await addResult(page, `GET /api/tasks/${taskId} (verify update)`, getUpdated.status, {
    name: getUpdated.body?.name,
    correct: nameOk
  }, 200)

  // 7. Pause task
  const pause = await browserFetch(page, 'POST', `/api/tasks/${taskId}/pause`, { token })
  check(pause.status, 200)
  await addResult(page, `POST /api/tasks/${taskId}/pause`, pause.status, pause.body, 200)

  // 8. Resume task
  const resume = await browserFetch(page, 'POST', `/api/tasks/${taskId}/resume`, { token })
  check(resume.status, 200)
  await addResult(page, `POST /api/tasks/${taskId}/resume`, resume.status, resume.body, 200)

  // 9. GET task runs (should be empty initially)
  const runs = await browserFetch(page, 'GET', `/api/tasks/${taskId}/runs`, { token })
  check(runs.status, 200)
  await addResult(page, `GET /api/tasks/${taskId}/runs`, runs.status, {
    count: Array.isArray(runs.body) ? runs.body.length : 'not array'
  }, 200)

  // 10. Reset session (for tasks with session continuity)
  const resetSession = await browserFetch(page, 'POST', `/api/tasks/${taskId}/reset-session`, { token })
  check(resetSession.status, 200)
  await addResult(page, `POST /api/tasks/${taskId}/reset-session`, resetSession.status, resetSession.body, 200)

  // 11. DELETE task
  const del = await browserFetch(page, 'DELETE', `/api/tasks/${taskId}`, { token })
  check(del.status, 200)
  await addResult(page, `DELETE /api/tasks/${taskId}`, del.status, del.body, 200)

  // 12. GET deleted task → 404
  const getDeleted = await browserFetch(page, 'GET', `/api/tasks/${taskId}`, { token })
  check(getDeleted.status, 404)
  await addResult(page, `GET /api/tasks/${taskId} (after delete)`, getDeleted.status, getDeleted.body, 404)

  // Cleanup second task
  await browserFetch(page, 'DELETE', `/api/tasks/${create2.body?.id}`, { token })

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/crud-tasks-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
