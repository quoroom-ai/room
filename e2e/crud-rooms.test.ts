/**
 * E2E: Full CRUD lifecycle for Rooms.
 * Tests GET individual, PATCH update, DELETE, activity log, queen endpoints.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Rooms — full CRUD + status + activity + queen', async ({ page }) => {
  await injectTestUI(page, 'Rooms — Full CRUD Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // 1. Create room
  const create = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'CRUD Test Room', goal: 'Test all room endpoints' }
  })
  check(create.status, 201)
  await addResult(page, 'POST /api/rooms', create.status, create.body, 201)
  const roomId = create.body?.room?.id

  // 2. GET individual room
  const getRoom = await browserFetch(page, 'GET', `/api/rooms/${roomId}`, { token })
  check(getRoom.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}`, getRoom.status, {
    id: getRoom.body?.id,
    name: getRoom.body?.name,
    goal: getRoom.body?.goal
  }, 200)

  // 3. PATCH update room
  const patchRoom = await browserFetch(page, 'PATCH', `/api/rooms/${roomId}`, {
    token,
    body: { name: 'Updated CRUD Room', goal: 'Updated goal' }
  })
  check(patchRoom.status, 200)
  await addResult(page, `PATCH /api/rooms/${roomId}`, patchRoom.status, patchRoom.body, 200)

  // 4. Verify update via GET
  const getUpdated = await browserFetch(page, 'GET', `/api/rooms/${roomId}`, { token })
  const nameUpdated = getUpdated.body?.name === 'Updated CRUD Room'
  if (nameUpdated) passed++; else failed++
  await addResult(page, `GET /api/rooms/${roomId} (verify update)`, getUpdated.status,
    { name: getUpdated.body?.name, nameCorrect: nameUpdated }, 200)

  // 5. GET room status
  const status = await browserFetch(page, 'GET', `/api/rooms/${roomId}/status`, { token })
  check(status.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/status`, status.status, {
    workers: status.body?.workers?.length,
    activeGoals: status.body?.activeGoals?.length,
    pendingDecisions: status.body?.pendingDecisions
  }, 200)

  // 6. GET room activity
  const activity = await browserFetch(page, 'GET', `/api/rooms/${roomId}/activity`, { token })
  check(activity.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/activity`, activity.status,
    { entries: Array.isArray(activity.body) ? activity.body.length : 'not array' }, 200)

  await page.screenshot({ path: 'e2e/screenshots/crud-rooms-01.png', fullPage: true })

  // 7. GET room queen
  const queen = await browserFetch(page, 'GET', `/api/rooms/${roomId}/queen`, { token })
  check(queen.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/queen`, queen.status, {
    id: queen.body?.id,
    name: queen.body?.name
  }, 200)

  // 8. Pause room
  const pause = await browserFetch(page, 'POST', `/api/rooms/${roomId}/pause`, { token })
  check(pause.status, 200)
  await addResult(page, `POST /api/rooms/${roomId}/pause`, pause.status, pause.body, 200)

  // 9. Restart room
  const restart = await browserFetch(page, 'POST', `/api/rooms/${roomId}/restart`, { token })
  check(restart.status, 200)
  await addResult(page, `POST /api/rooms/${roomId}/restart`, restart.status, restart.body, 200)

  // 10. GET room workers
  const workers = await browserFetch(page, 'GET', `/api/rooms/${roomId}/workers`, { token })
  check(workers.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/workers`, workers.status,
    { count: Array.isArray(workers.body) ? workers.body.length : 'not array' }, 200)

  // 11. List rooms (verify ours is in the list)
  const list = await browserFetch(page, 'GET', '/api/rooms', { token })
  const found = Array.isArray(list.body) && list.body.some((r: any) => r.id === roomId)
  if (found) passed++; else failed++
  await addResult(page, 'GET /api/rooms (list contains ours)', list.status,
    { totalRooms: list.body?.length, ourRoomFound: found }, 200)

  // 12. DELETE room
  const del = await browserFetch(page, 'DELETE', `/api/rooms/${roomId}`, { token })
  check(del.status, 200)
  await addResult(page, `DELETE /api/rooms/${roomId}`, del.status, del.body, 200)

  // 13. GET deleted room → 404
  const getDeleted = await browserFetch(page, 'GET', `/api/rooms/${roomId}`, { token })
  check(getDeleted.status, 404)
  await addResult(page, `GET /api/rooms/${roomId} (after delete)`, getDeleted.status, getDeleted.body, 404)

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/crud-rooms-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
