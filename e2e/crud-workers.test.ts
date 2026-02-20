/**
 * E2E: Full CRUD lifecycle for Workers.
 * Tests list, get, update, delete operations.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Workers — full CRUD lifecycle', async ({ page }) => {
  await injectTestUI(page, 'Workers — Full CRUD Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // Setup: Create a room for the workers
  const room = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'Worker Test Room', goal: 'Test worker CRUD' }
  })
  const roomId = room.body?.room?.id

  // 1. Create worker
  const create = await browserFetch(page, 'POST', '/api/workers', {
    token,
    body: { name: 'Test Worker Alpha', systemPrompt: 'You are a test worker.', roomId }
  })
  check(create.status, 201)
  await addResult(page, 'POST /api/workers', create.status, {
    id: create.body?.id,
    name: create.body?.name
  }, 201)
  const workerId = create.body?.id

  // 2. Create second worker
  const create2 = await browserFetch(page, 'POST', '/api/workers', {
    token,
    body: { name: 'Test Worker Beta', systemPrompt: 'You are a second test worker.', roomId }
  })
  check(create2.status, 201)
  await addResult(page, 'POST /api/workers (second)', create2.status, {
    id: create2.body?.id,
    name: create2.body?.name
  }, 201)

  // 3. List all workers
  const list = await browserFetch(page, 'GET', '/api/workers', { token })
  check(list.status, 200)
  const ourWorkers = Array.isArray(list.body) ? list.body.filter((w: any) => w.roomId === roomId) : []
  await addResult(page, 'GET /api/workers', list.status, {
    total: list.body?.length,
    inOurRoom: ourWorkers.length
  }, 200)

  // 4. GET individual worker
  const get = await browserFetch(page, 'GET', `/api/workers/${workerId}`, { token })
  check(get.status, 200)
  await addResult(page, `GET /api/workers/${workerId}`, get.status, {
    id: get.body?.id,
    name: get.body?.name,
    systemPrompt: get.body?.systemPrompt?.slice(0, 30) + '...'
  }, 200)

  await page.screenshot({ path: 'e2e/screenshots/crud-workers-01.png', fullPage: true })

  // 5. PATCH update worker
  const patch = await browserFetch(page, 'PATCH', `/api/workers/${workerId}`, {
    token,
    body: { name: 'Updated Worker Alpha', systemPrompt: 'Updated system prompt.' }
  })
  check(patch.status, 200)
  await addResult(page, `PATCH /api/workers/${workerId}`, patch.status, patch.body, 200)

  // 6. Verify update
  const getUpdated = await browserFetch(page, 'GET', `/api/workers/${workerId}`, { token })
  const nameOk = getUpdated.body?.name === 'Updated Worker Alpha'
  if (nameOk) passed++; else failed++
  await addResult(page, `GET /api/workers/${workerId} (verify update)`, getUpdated.status, {
    name: getUpdated.body?.name,
    nameCorrect: nameOk
  }, 200)

  // 7. GET room-specific workers
  const roomWorkers = await browserFetch(page, 'GET', `/api/rooms/${roomId}/workers`, { token })
  check(roomWorkers.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/workers`, roomWorkers.status, {
    count: Array.isArray(roomWorkers.body) ? roomWorkers.body.length : 'not array'
  }, 200)

  // 8. DELETE worker
  const del = await browserFetch(page, 'DELETE', `/api/workers/${workerId}`, { token })
  check(del.status, 200)
  await addResult(page, `DELETE /api/workers/${workerId}`, del.status, del.body, 200)

  // 9. GET deleted worker → 404
  const getDeleted = await browserFetch(page, 'GET', `/api/workers/${workerId}`, { token })
  check(getDeleted.status, 404)
  await addResult(page, `GET /api/workers/${workerId} (after delete)`, getDeleted.status, getDeleted.body, 404)

  // Cleanup
  await browserFetch(page, 'DELETE', `/api/rooms/${roomId}`, { token })

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/crud-workers-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
