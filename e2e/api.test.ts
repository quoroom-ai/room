/**
 * E2E: REST API tested from a real browser.
 * Screenshots capture formatted results at each stage.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('REST API — full CRUD lifecycle', async ({ page }) => {
  await injectTestUI(page, 'REST API — CRUD Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // 1. Auth handshake
  const handshake = await browserFetch(page, 'GET', '/api/auth/handshake')
  check(handshake.status, 200)
  await addResult(page, 'GET /api/auth/handshake', handshake.status, handshake.body, 200)

  // 2. Auth verify
  const verify = await browserFetch(page, 'GET', '/api/auth/verify', { token })
  check(verify.status, 200)
  await addResult(page, 'GET /api/auth/verify', verify.status, verify.body, 200)

  // 3. Create room
  const createRoom = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'E2E Test Room', goal: 'Validate all API endpoints' }
  })
  check(createRoom.status, 201)
  await addResult(page, 'POST /api/rooms', createRoom.status, createRoom.body, 201)
  const roomId = createRoom.body?.room?.id
  const queenId = createRoom.body?.queen?.id

  // 4. List rooms
  const listRooms = await browserFetch(page, 'GET', '/api/rooms', { token })
  check(listRooms.status, 200)
  await addResult(page, 'GET /api/rooms', listRooms.status, `${listRooms.body?.length} room(s)`, 200)

  // 5. Room status
  const roomStatus = await browserFetch(page, 'GET', `/api/rooms/${roomId}/status`, { token })
  check(roomStatus.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/status`, roomStatus.status, {
    workers: roomStatus.body?.workers?.length,
    activeGoals: roomStatus.body?.activeGoals?.length,
    pendingDecisions: roomStatus.body?.pendingDecisions
  }, 200)

  await page.screenshot({ path: 'e2e/screenshots/api-01-rooms.png', fullPage: true })

  // 6. Create worker
  const createWorker = await browserFetch(page, 'POST', '/api/workers', {
    token,
    body: { name: 'E2E Worker', systemPrompt: 'You help with e2e tests.', roomId }
  })
  check(createWorker.status, 201)
  await addResult(page, 'POST /api/workers', createWorker.status, { id: createWorker.body?.id, name: createWorker.body?.name }, 201)

  // 7. Create sub-goal
  const createGoal = await browserFetch(page, 'POST', `/api/rooms/${roomId}/goals`, {
    token,
    body: { description: 'Test sub-goal from browser', parentGoalId: createRoom.body?.rootGoal?.id }
  })
  check(createGoal.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/goals`, createGoal.status, { id: createGoal.body?.id, description: createGoal.body?.description }, 201)

  // 8. Propose decision
  const createDecision = await browserFetch(page, 'POST', `/api/rooms/${roomId}/decisions`, {
    token,
    body: { proposerId: queenId, proposal: 'E2E test proposal', decisionType: 'majority' }
  })
  check(createDecision.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/decisions`, createDecision.status, { id: createDecision.body?.id, status: createDecision.body?.status }, 201)

  // 9. Cast vote
  const vote = await browserFetch(page, 'POST', `/api/decisions/${createDecision.body?.id}/vote`, {
    token,
    body: { workerId: queenId, vote: 'yes', reasoning: 'Automated test vote' }
  })
  check(vote.status, 201)
  await addResult(page, `POST /api/decisions/${createDecision.body?.id}/vote`, vote.status, { vote: vote.body?.vote }, 201)

  await page.screenshot({ path: 'e2e/screenshots/api-02-entities.png', fullPage: true })

  // 10. Memory entity
  const createEntity = await browserFetch(page, 'POST', '/api/memory/entities', {
    token,
    body: { name: 'E2E Test Memory', type: 'fact', category: 'project' }
  })
  check(createEntity.status, 201)
  await addResult(page, 'POST /api/memory/entities', createEntity.status, createEntity.body, 201)

  // 11. Add observation
  const addObs = await browserFetch(page, 'POST', `/api/memory/entities/${createEntity.body?.id}/observations`, {
    token,
    body: { content: 'This observation was created from a Playwright browser test.' }
  })
  check(addObs.status, 201)
  await addResult(page, 'POST /api/memory/entities/:id/observations', addObs.status, addObs.body, 201)

  // 12. Create task
  const createTask = await browserFetch(page, 'POST', '/api/tasks', {
    token,
    body: { prompt: 'E2E browser test task', name: 'Browser Task' }
  })
  check(createTask.status, 201)
  await addResult(page, 'POST /api/tasks', createTask.status, { id: createTask.body?.id, name: createTask.body?.name }, 201)

  // 13. Settings
  const setSetting = await browserFetch(page, 'PUT', '/api/settings/e2e_test', {
    token,
    body: { value: 'playwright' }
  })
  check(setSetting.status, 200)
  await addResult(page, 'PUT /api/settings/e2e_test', setSetting.status, setSetting.body, 200)

  const getSetting = await browserFetch(page, 'GET', '/api/settings/e2e_test', { token })
  check(getSetting.status, 200)
  await addResult(page, 'GET /api/settings/e2e_test', getSetting.status, getSetting.body, 200)

  // 14. Pause + restart room
  const pause = await browserFetch(page, 'POST', `/api/rooms/${roomId}/pause`, { token })
  check(pause.status, 200)
  await addResult(page, `POST /api/rooms/${roomId}/pause`, pause.status, pause.body, 200)

  const restart = await browserFetch(page, 'POST', `/api/rooms/${roomId}/restart`, { token })
  check(restart.status, 200)
  await addResult(page, `POST /api/rooms/${roomId}/restart`, restart.status, restart.body, 200)

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/api-03-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
