/**
 * E2E: Room accordion navigation tests.
 * Verifies that:
 * 1. Clicking a tab under a room shows data for that room (correct roomId passed to panel)
 * 2. Switching rooms switches the panel context
 * 3. Page refresh restores selected room + tab
 */

import { test, expect, type Page } from '@playwright/test'
import { getToken, getBaseUrl } from './helpers'

const base = getBaseUrl()

async function waitForReady(page: Page) {
  await page.locator('button').filter({ hasText: /Settings|Help/i }).first().waitFor({ timeout: 10000 })
}

function sidebar(page: Page) {
  return page.getByTestId('sidebar')
}

/** Click a room header in the accordion and wait for its submenu to appear.
 *  If the room is already expanded (▴ chevron), skip the click — it would toggle closed. */
async function expandRoom(page: Page, roomName: string) {
  const roomBtn = sidebar(page).locator('button').filter({ hasText: roomName }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const btnText = await roomBtn.textContent()
  if (!btnText?.includes('▴')) {
    await roomBtn.click()
  }
  // Wait for Overview (first tab) to appear in this room's submenu
  await expect(sidebar(page).locator('button').filter({ hasText: /^Overview$/ })).toBeVisible({ timeout: 5000 })
}

/** Click a tab within the currently open room submenu. */
async function clickTab(page: Page, tabLabel: string) {
  await sidebar(page).locator('button').filter({ hasText: new RegExp(`^${tabLabel}$`) }).click()
}

test.describe('UI — Accordion room navigation', () => {
  let roomAId: number
  let roomBId: number
  const token = getToken()

  test.beforeAll(async ({ request }) => {
    // Clean up any leftover rooms from previous runs to avoid duplicate-name strict mode violations
    const listRes = await request.get(`${base}/api/rooms`, { headers: { Authorization: `Bearer ${token}` } })
    if (listRes.ok()) {
      const body = await listRes.json() as Array<{ id: number; name: string }> | { rooms: Array<{ id: number; name: string }> }
      const list = Array.isArray(body) ? body : body.rooms ?? []
      for (const r of list) {
        if (r.name === 'Accordion Test Room A' || r.name === 'Accordion Test Room B') {
          await request.delete(`${base}/api/rooms/${r.id}`, { headers: { Authorization: `Bearer ${token}` } })
        }
      }
    }

    const a = await request.post(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Accordion Test Room A', goal: 'Room A goal' }
    })
    const b = await request.post(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Accordion Test Room B', goal: 'Room B goal' }
    })
    roomAId = (await a.json()).room.id
    roomBId = (await b.json()).room.id

    // Create a worker in each room so Workers panel shows room-specific content
    await request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Worker for Room A', systemPrompt: 'room a', roomId: roomAId }
    })
    await request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Worker for Room B', systemPrompt: 'room b', roomId: roomBId }
    })
  })

  test.afterAll(async ({ request }) => {
    await request.delete(`${base}/api/rooms/${roomAId}`, { headers: { Authorization: `Bearer ${token}` } })
    await request.delete(`${base}/api/rooms/${roomBId}`, { headers: { Authorization: `Bearer ${token}` } })
  })

  test.beforeEach(async ({ page }) => {
    // Enable advanced mode so Workers tab is accessible in the accordion
    await page.request.put(`${base}/api/settings/advanced_mode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { value: 'true' }
    })
    // On the first load of each test (fresh page = empty sessionStorage), clear tab/room state.
    // On reloads within individual tests, sessionStorage survives so state is preserved.
    // Always suppress the walkthrough modal.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('_e2e_init')) {
        localStorage.removeItem('quoroom_tab')
        localStorage.removeItem('quoroom_room')
        sessionStorage.setItem('_e2e_init', '1')
      }
      localStorage.setItem('quoroom_walkthrough_seen', 'true')
    })
    await page.goto(base, { waitUntil: 'networkidle' })
    await waitForReady(page)
  })

  test('room accordion renders rooms in sidebar', async ({ page }) => {
    await expect(sidebar(page).locator('button').filter({ hasText: 'Accordion Test Room A' })).toBeVisible({ timeout: 10000 })
    await expect(sidebar(page).locator('button').filter({ hasText: 'Accordion Test Room B' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/accordion-01-sidebar.png', fullPage: true })
  })

  test('clicking a room expands its tab submenu', async ({ page }) => {
    await expandRoom(page, 'Accordion Test Room B')
    // Submenu tab is visible inside the sidebar
    await expect(sidebar(page).locator('button').filter({ hasText: /^Overview$/ })).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/accordion-02-expanded.png', fullPage: true })
  })

  test('tabs show data for the selected room', async ({ page }) => {
    // Open Room A → Workers
    await expandRoom(page, 'Accordion Test Room A')
    await clickTab(page, 'Workers')

    await expect(page.getByText('Worker for Room A')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Worker for Room B')).not.toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/accordion-03-room-a-workers.png', fullPage: true })

    // Open Room B → Workers
    await expandRoom(page, 'Accordion Test Room B')
    await clickTab(page, 'Workers')

    await expect(page.getByText('Worker for Room B')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Worker for Room A')).not.toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/accordion-04-room-b-workers.png', fullPage: true })
  })

  test('only one room submenu open at a time', async ({ page }) => {
    // Expand Room A
    await expandRoom(page, 'Accordion Test Room A')
    let activityCount = await sidebar(page).locator('button').filter({ hasText: /^Overview$/ }).count()
    expect(activityCount).toBe(1)

    // Expand Room B — Room A should collapse, Room B opens
    await expandRoom(page, 'Accordion Test Room B')
    activityCount = await sidebar(page).locator('button').filter({ hasText: /^Overview$/ }).count()
    expect(activityCount).toBe(1)

    await page.screenshot({ path: 'e2e/screenshots/accordion-05-one-open.png', fullPage: true })
  })

  test('page refresh restores selected room and tab', async ({ page }) => {
    // Navigate to Room B → Goals
    await expandRoom(page, 'Accordion Test Room B')
    await clickTab(page, 'Goals')
    await expect(page.getByText(/goal\(s\)/i)).toBeVisible({ timeout: 5000 })

    // Reload
    await page.reload({ waitUntil: 'networkidle' })
    await waitForReady(page)

    // Goals panel still active
    await expect(page.getByText(/goal\(s\)/i)).toBeVisible({ timeout: 5000 })
    // Room B submenu still expanded
    await expect(sidebar(page).locator('button').filter({ hasText: /^Overview$/ })).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'e2e/screenshots/accordion-06-after-refresh.png', fullPage: true })
  })
})
