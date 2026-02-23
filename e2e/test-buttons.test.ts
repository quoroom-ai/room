/**
 * E2E: Test that room toggle buttons (Auto/Semi) actually work.
 */

import { test, expect, type Page } from '@playwright/test'
import { getToken, getBaseUrl } from './helpers'

const base = getBaseUrl()
const token = getToken()

let _roomId: number | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientRequestError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network/i.test(msg)
}

async function getRoomWithRetry(page: Page, roomId: number): Promise<{ autonomyMode?: string }> {
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await page.request.get(`${base}/api/rooms/${roomId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.status() === 200) return res.json()
      if (attempt < maxAttempts - 1) {
        await sleep(200 * (attempt + 1))
        continue
      }
      throw new Error(`Unexpected status ${res.status()} while fetching room ${roomId}`)
    } catch (err) {
      if (!isTransientRequestError(err) || attempt === maxAttempts - 1) throw err
      await sleep(200 * (attempt + 1))
    }
  }
  throw new Error(`Failed to fetch room ${roomId}`)
}

test.afterEach(async ({ page }) => {
  // Always clean up the test room
  if (_roomId) {
    await page.request.delete(`${base}/api/rooms/${_roomId}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {})
    _roomId = null
  }
})

test('Room toggle buttons update room settings', async ({ page }) => {
  // Suppress walkthrough modal
  await page.addInitScript(() => {
    localStorage.setItem('quoroom_walkthrough_seen', 'true')
    localStorage.setItem('quoroom_contact_prompt_seen', '1')
  })

  // Create a test room via API
  const create = await page.request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: 'Button Test Room', goal: 'Test buttons' }
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json())?.room?.id
  expect(roomId).toBeTruthy()
  _roomId = roomId

  // Navigate to the SPA and wait for rooms to load
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  // Click the room in the sidebar to expand its submenu
  const sidebar = page.locator('[data-testid="sidebar"]')
  const roomBtn = sidebar.locator('button').filter({ hasText: /Button Test Room/i }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const btnText = await roomBtn.textContent()
  if (!btnText?.includes('\u25B4')) {
    await roomBtn.click()
  }

  // Click the room-level Settings tab in the submenu
  const settingsTab = sidebar.locator('button').filter({ hasText: /^Settings$/i }).first()
  await settingsTab.waitFor({ timeout: 5000 })
  await settingsTab.click()

  // Find the "Semi" button and click it, waiting for the PATCH response
  const semiBtn = page.locator('button').filter({ hasText: /^Semi$/i }).first()
  await expect(semiBtn).toBeVisible({ timeout: 15000 })

  const [patchRes] = await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/rooms') && res.request().method() === 'PATCH', { timeout: 10000 }),
    semiBtn.click()
  ])
  expect(patchRes.status()).toBe(200)

  // Verify via API that the room was updated
  const roomAfter = await getRoomWithRetry(page, roomId)
  expect(roomAfter?.autonomyMode).toBe('semi')

  // Click "Auto" to reset
  const autoBtn = page.locator('button').filter({ hasText: /^Auto$/i }).first()
  await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/rooms') && res.request().method() === 'PATCH', { timeout: 10000 }),
    autoBtn.click()
  ])

  // Verify reset
  const roomReset = await getRoomWithRetry(page, roomId)
  expect(roomReset?.autonomyMode).toBe('auto')
})
