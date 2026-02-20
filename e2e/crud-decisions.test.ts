/**
 * E2E: Full CRUD lifecycle for Decisions.
 * Tests list, get, voting, resolve operations.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Decisions — full lifecycle: propose → vote → resolve', async ({ page }) => {
  await injectTestUI(page, 'Decisions — Full Lifecycle')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // Setup: Create room (gets queen worker automatically)
  const room = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'Decision Test Room', goal: 'Test decision endpoints' }
  })
  const roomId = room.body?.room?.id
  const queenId = room.body?.queen?.id

  // 1. Create decision proposal
  const create = await browserFetch(page, 'POST', `/api/rooms/${roomId}/decisions`, {
    token,
    body: {
      proposerId: queenId,
      proposal: 'Should we adopt TypeScript strict mode?',
      decisionType: 'majority'
    }
  })
  check(create.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/decisions`, create.status, {
    id: create.body?.id,
    status: create.body?.status,
    proposal: create.body?.proposal
  }, 201)
  const decisionId = create.body?.id

  // 2. Create second decision
  const create2 = await browserFetch(page, 'POST', `/api/rooms/${roomId}/decisions`, {
    token,
    body: {
      proposerId: queenId,
      proposal: 'Should we add rate limiting?',
      decisionType: 'low_impact'
    }
  })
  check(create2.status, 201)
  await addResult(page, `POST /api/rooms/${roomId}/decisions (second)`, create2.status, {
    id: create2.body?.id
  }, 201)

  // 3. List room decisions
  const list = await browserFetch(page, 'GET', `/api/rooms/${roomId}/decisions`, { token })
  check(list.status, 200)
  await addResult(page, `GET /api/rooms/${roomId}/decisions`, list.status, {
    count: Array.isArray(list.body) ? list.body.length : 'not array'
  }, 200)

  // 4. GET individual decision
  const get = await browserFetch(page, 'GET', `/api/decisions/${decisionId}`, { token })
  check(get.status, 200)
  await addResult(page, `GET /api/decisions/${decisionId}`, get.status, {
    id: get.body?.id,
    proposal: get.body?.proposal,
    status: get.body?.status
  }, 200)

  await page.screenshot({ path: 'e2e/screenshots/crud-decisions-01.png', fullPage: true })

  // 5. Cast vote (yes)
  const vote = await browserFetch(page, 'POST', `/api/decisions/${decisionId}/vote`, {
    token,
    body: { workerId: queenId, vote: 'yes', reasoning: 'Type safety is important' }
  })
  check(vote.status, 201)
  await addResult(page, `POST /api/decisions/${decisionId}/vote`, vote.status, {
    vote: vote.body?.vote,
    reasoning: vote.body?.reasoning
  }, 201)

  // 6. GET votes for decision
  const votes = await browserFetch(page, 'GET', `/api/decisions/${decisionId}/votes`, { token })
  check(votes.status, 200)
  await addResult(page, `GET /api/decisions/${decisionId}/votes`, votes.status, {
    count: Array.isArray(votes.body) ? votes.body.length : 'not array'
  }, 200)

  // 7. Resolve decision
  const resolve = await browserFetch(page, 'POST', `/api/decisions/${decisionId}/resolve`, {
    token,
    body: { status: 'approved', result: 'Adopted with full support' }
  })
  check(resolve.status, 200)
  await addResult(page, `POST /api/decisions/${decisionId}/resolve`, resolve.status, resolve.body, 200)

  // 8. Verify resolution
  const getResolved = await browserFetch(page, 'GET', `/api/decisions/${decisionId}`, { token })
  const isResolved = getResolved.body?.status === 'approved' || getResolved.body?.resolution === 'approved'
  if (isResolved) passed++; else failed++
  await addResult(page, `GET /api/decisions/${decisionId} (verify resolved)`, getResolved.status, {
    status: getResolved.body?.status,
    resolution: getResolved.body?.resolution,
    resolved: isResolved
  }, 200)

  // Cleanup
  await browserFetch(page, 'DELETE', `/api/rooms/${roomId}`, { token })

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/crud-decisions-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
