/**
 * E2E: Test that room toggle buttons (Auto/Semi, Claude/Ollama) actually work.
 */

import { test, expect } from '@playwright/test'
import { getToken, getBaseUrl, injectTestUI, browserFetch } from './helpers'

const base = getBaseUrl()
const token = getToken()

test('Room toggle buttons update room settings', async ({ page }) => {
  // Navigate to establish origin before browserFetch
  await injectTestUI(page, 'Button Test')

  // Create a test room
  const create = await browserFetch(page, 'POST', '/api/rooms', {
    token,
    body: { name: 'Button Test Room', goal: 'Test buttons' }
  })
  expect(create.status).toBe(201)
  const roomId = create.body?.room?.id
  expect(roomId).toBeTruthy()

  const patchCalls: Array<{ url: string; status: number }> = []
  page.on('response', async (res) => {
    if (res.url().includes('/api/rooms') && res.request().method() === 'PATCH') {
      patchCalls.push({ url: res.url(), status: res.status() })
    }
  })

  // Navigate to Settings tab (the SPA)
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: /^Settings$/i }).first().click()
  await page.waitForTimeout(2000)

  // Find the "Semi" button inside the rooms panel
  const semiBtn = page.locator('button').filter({ hasText: /^Semi$/i }).first()
  await expect(semiBtn).toBeVisible({ timeout: 5000 })

  // Click "Semi"
  await semiBtn.click()
  await page.waitForTimeout(1500)

  // Verify the API was called
  expect(patchCalls.length).toBeGreaterThan(0)
  expect(patchCalls[0].status).toBe(200)

  // Verify via API that the room was updated
  const roomAfter = await browserFetch(page, 'GET', `/api/rooms/${roomId}`, { token })
  expect(roomAfter.body?.autonomyMode).toBe('semi')

  // Click "Auto" to reset
  const autoBtn = page.locator('button').filter({ hasText: /^Auto$/i }).first()
  await autoBtn.click()
  await page.waitForTimeout(1000)

  // Cleanup
  await browserFetch(page, 'DELETE', `/api/rooms/${roomId}`, { token })
})
