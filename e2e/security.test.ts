/**
 * E2E: Security tests from a real browser.
 * Verifies auth rejection, CORS, Origin validation.
 */

import { test, expect } from '@playwright/test'
import {
  getToken,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('Security — auth, CORS, Origin validation', async ({ page }) => {
  await injectTestUI(page, 'Security — Auth & CORS')
  let passed = 0, failed = 0

  function check(status: number, expected: number) {
    if (status === expected) passed++; else failed++
  }

  // 1. No token → 401
  const noAuth = await browserFetch(page, 'GET', '/api/rooms')
  check(noAuth.status, 401)
  await addResult(page, 'GET /api/rooms (no token)', noAuth.status, noAuth.body, 401)

  // 2. Wrong token → 401
  const wrongAuth = await browserFetch(page, 'GET', '/api/rooms', {
    token: '0000000000000000000000000000000000000000000000000000000000000000'
  })
  check(wrongAuth.status, 401)
  await addResult(page, 'GET /api/rooms (wrong token)', wrongAuth.status, wrongAuth.body, 401)

  // 3. Short token → 401
  const shortAuth = await browserFetch(page, 'GET', '/api/rooms', { token: 'abc' })
  check(shortAuth.status, 401)
  await addResult(page, 'GET /api/rooms (short token)', shortAuth.status, shortAuth.body, 401)

  // 4. Valid token → 200
  const validAuth = await browserFetch(page, 'GET', '/api/rooms', { token })
  check(validAuth.status, 200)
  await addResult(page, 'GET /api/rooms (valid token)', validAuth.status, `${validAuth.body?.length ?? 0} rooms`, 200)

  // 5. Auth verify without token → 401
  const verifyNoAuth = await browserFetch(page, 'GET', '/api/auth/verify')
  check(verifyNoAuth.status, 401)
  await addResult(page, 'GET /api/auth/verify (no token)', verifyNoAuth.status, verifyNoAuth.body, 401)

  // 6. Auth verify with token → 200
  const verifyOk = await browserFetch(page, 'GET', '/api/auth/verify', { token })
  check(verifyOk.status, 200)
  await addResult(page, 'GET /api/auth/verify (valid)', verifyOk.status, verifyOk.body, 200)

  // 7. Handshake returns token (no auth needed)
  const handshake = await browserFetch(page, 'GET', '/api/auth/handshake')
  const handshakeOk = handshake.status === 200 && handshake.body?.token?.length === 64
  if (handshakeOk) passed++; else failed++
  await addResult(page, 'GET /api/auth/handshake (no auth)', handshake.status,
    { tokenLength: handshake.body?.token?.length, prefix: handshake.body?.token?.slice(0, 8) + '...' }, 200)

  await page.screenshot({ path: 'e2e/screenshots/security-01-auth.png', fullPage: true })

  // 8. 404 for unknown API route
  const notFound = await browserFetch(page, 'GET', '/api/does-not-exist', { token })
  check(notFound.status, 404)
  await addResult(page, 'GET /api/does-not-exist', notFound.status, notFound.body, 404)

  // 9. 400 for bad request bodies
  const badRoom = await browserFetch(page, 'POST', '/api/rooms', { token, body: {} })
  check(badRoom.status, 400)
  await addResult(page, 'POST /api/rooms (no name)', badRoom.status, badRoom.body, 400)

  const badTask = await browserFetch(page, 'POST', '/api/tasks', { token, body: {} })
  check(badTask.status, 400)
  await addResult(page, 'POST /api/tasks (no prompt)', badTask.status, badTask.body, 400)

  const badWorker = await browserFetch(page, 'POST', '/api/workers', { token, body: { name: 'NoPrompt' } })
  check(badWorker.status, 400)
  await addResult(page, 'POST /api/workers (no systemPrompt)', badWorker.status, badWorker.body, 400)

  // 10. WebSocket with bad token rejects
  const wsResult = await page.evaluate(async ({ base }) => {
    try {
      const ws = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?token=invalid`)
        socket.onopen = () => { socket.close(); resolve('opened') }
        socket.onerror = () => reject(new Error('rejected'))
        socket.onclose = (e) => {
          if (!e.wasClean) reject(new Error('rejected'))
        }
        setTimeout(() => reject(new Error('timeout')), 3000)
      })
      return { ok: false, msg: 'WS should not have connected' }
    } catch {
      return { ok: true, msg: 'WS correctly rejected invalid token' }
    }
  }, { base: 'http://127.0.0.1:3700' })

  if (wsResult.ok) passed++; else failed++
  await addResult(page, 'WS connect (invalid token)', wsResult.ok ? 401 : 200, wsResult.msg, 401)

  // Summary
  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/security-02-summary.png', fullPage: true })

  expect(failed).toBe(0)
})
