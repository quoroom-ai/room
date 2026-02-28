/**
 * E2E: Room autonomy mode behavior in UI/API.
 * Auto/Semi switching was removed; rooms now run in semi mode only.
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

test('Room settings reflects always-semi autonomy mode', async ({ page }) => {
  // Suppress walkthrough modal
  await page.addInitScript(() => {
    localStorage.setItem('quoroom_walkthrough_seen', 'true')
    localStorage.setItem('quoroom_contact_prompt_seen', '1')
    localStorage.setItem('quoroom_tab', 'status')
  })

  // Create a test room via API
  const create = await page.request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: 'ButtonTestRoom', goal: 'Test buttons' }
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json())?.room?.id
  expect(roomId).toBeTruthy()
  _roomId = roomId

  // Navigate to the SPA and wait for rooms to load
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  // Click the room in the sidebar to expand its submenu
  const sidebar = page.locator('[data-testid="sidebar"]')
  const roomBtn = sidebar.locator('button').filter({ hasText: /ButtonTestRoom/i }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const btnText = await roomBtn.textContent()
  if (!btnText?.includes('\u25B4')) {
    await roomBtn.click()
  }

  // Click the room-level Settings tab in the submenu
  const settingsTab = sidebar.locator('button').filter({ hasText: /^Settings$/i }).first()
  await settingsTab.waitFor({ timeout: 5000 })
  await settingsTab.click()

  // Auto/Semi toggle no longer exists in room settings.
  await expect(page.locator('button').filter({ hasText: /^Semi$/i })).toHaveCount(0)
  await expect(page.locator('button').filter({ hasText: /^Auto$/i })).toHaveCount(0)

  // Verify via API that room mode is always semi.
  const room = await getRoomWithRetry(page, roomId)
  expect(room?.autonomyMode).toBe('semi')
})
