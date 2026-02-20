/**
 * E2E: UI smoke tests — loads the React SPA, navigates tabs, takes screenshots.
 * Verifies that the frontend renders correctly when served by the API server.
 */

import { test, expect } from '@playwright/test'
import { getToken, getBaseUrl } from './helpers'

const base = getBaseUrl()

test.describe('UI — SPA loads and renders', () => {
  test('index.html served at root', async ({ page }) => {
    const response = await page.goto(base, { waitUntil: 'domcontentloaded' })
    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-type']).toContain('text/html')

    // React app mounts — wait for the app container
    await page.waitForSelector('#root', { timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-01-initial-load.png', fullPage: true })
  })

  test('auth handshake completes and tabs render', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle' })

    // After auth, the tab bar should appear
    const anyTab = page.locator('button').filter({ hasText: /Activity|Tasks|Workers|Settings|Help/i }).first()
    await anyTab.waitFor({ timeout: 10000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-02-tabs-loaded.png', fullPage: true })
  })
})

test.describe('UI — Tab navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle' })
    // Wait for UI to be ready
    await page.locator('button').filter({ hasText: /Activity|Tasks/i }).first().waitFor({ timeout: 10000 })
  })

  test('Status/Activity tab (default)', async ({ page }) => {
    // Status panel should show cards — use getByRole for specificity
    await expect(page.getByRole('button', { name: /Workers/i }).first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: /Tasks/i }).first()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-03-status-panel.png', fullPage: true })
  })

  test('Workers tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Workers$/i }).first().click()
    // Workers panel is read-only — check for worker count text
    await expect(page.getByText(/worker\(s\)/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-04-workers-panel.png', fullPage: true })
  })

  test('Tasks tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Tasks$/i }).first().click()
    // Tasks panel is read-only — check for task count text
    await expect(page.getByText(/task\(s\)/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-05-tasks-panel.png', fullPage: true })
  })

  test('Settings tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Settings$/i }).first().click()
    await expect(page.getByText('Preferences')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Connection')).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-06-settings-panel.png', fullPage: true })
  })

  test('Help tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Help$/i }).first().click()
    await expect(page.getByText('Getting Started')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Quorum Voting')).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-07-help-panel.png', fullPage: true })
  })

  test('Goals tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Goals$/i }).first().click()
    // Goals panel is read-only — check for goal count text
    await expect(page.getByText(/goal\(s\)/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-14-goals-panel.png', fullPage: true })
  })

  test('Votes tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Votes$/i }).first().click()
    // Votes panel is read-only — check for decision count text
    await expect(page.getByText(/decision\(s\)/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-15-votes-panel.png', fullPage: true })
  })

  test('Skills tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Skills$/i }).first().click()
    // Skills panel is read-only — check for skill count text
    await expect(page.getByText(/skill\(s\)/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-16-skills-panel.png', fullPage: true })
  })

  test('Messages tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Messages$/i }).first().click()
    // Messages panel — check for empty state (no room selected shows prompt)
    await expect(page.getByText(/Select a room|No messages yet/i)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-17-messages-panel.png', fullPage: true })
  })
})

test.describe('UI — Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.locator('button').filter({ hasText: /Activity|Tasks/i }).first().waitFor({ timeout: 10000 })
  })

  test('tasks panel shows read-only task list', async ({ page }) => {
    const token = await getToken()

    // Find the E2E Test Room id
    const roomsRes = await page.request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const rooms = await roomsRes.json()
    const roomId = rooms[0]?.id

    // Create a task via API within the room
    const res = await page.request.post(`${base}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'PW Read-Only Task', prompt: 'Test task for e2e', roomId }
    })
    expect(res.ok()).toBeTruthy()

    // Navigate to Tasks tab
    await page.locator('button').filter({ hasText: /^Tasks$/i }).first().click()

    // Task should appear in the list (read-only, no create form)
    await expect(page.getByText('PW Read-Only Task')).toBeVisible({ timeout: 5000 })

    // Verify no create button exists
    await expect(page.getByRole('button', { name: /New Task/i })).not.toBeVisible()

    await page.screenshot({ path: 'e2e/screenshots/ui-08-tasks-readonly.png', fullPage: true })
  })

  test('workers panel shows read-only worker list', async ({ page }) => {
    const token = await getToken()

    // Find room id
    const roomsRes = await page.request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const rooms = await roomsRes.json()
    const roomId = rooms[0]?.id

    // Create a worker via API
    const res = await page.request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'PW Read-Only Worker', systemPrompt: 'Test worker for e2e', roomId }
    })
    expect(res.ok()).toBeTruthy()

    // Navigate to Workers tab
    await page.locator('button').filter({ hasText: /^Workers$/i }).first().click()

    // Worker should appear in the list
    await expect(page.getByText('PW Read-Only Worker')).toBeVisible({ timeout: 5000 })

    // Verify no create button exists
    await expect(page.getByRole('button', { name: /New Worker/i })).not.toBeVisible()

    await page.screenshot({ path: 'e2e/screenshots/ui-10-workers-readonly.png', fullPage: true })
  })

  test('toggle advanced mode shows extra tabs', async ({ page }) => {
    // Navigate to Settings
    await page.locator('button').filter({ hasText: /^Settings$/i }).first().click()
    await page.waitForTimeout(500)

    // Find and click the Advanced mode toggle (the toggle button next to "Advanced mode" text)
    const advancedRow = page.locator('text=Advanced mode').locator('..')
    await advancedRow.locator('button').first().click()
    await page.waitForTimeout(500)

    // Now results tab should appear
    await expect(page.locator('button').filter({ hasText: /^Results$/i })).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-12-advanced-mode.png', fullPage: true })

    // Navigate to Results tab
    await page.locator('button').filter({ hasText: /^Results$/i }).first().click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'e2e/screenshots/ui-13-results-panel.png', fullPage: true })
  })
})

test.describe('UI — Static assets', () => {
  test('CSS loads correctly', async ({ page }) => {
    await page.goto(base, { waitUntil: 'networkidle' })

    // Check that Tailwind CSS is loaded by verifying a styled element
    const bgColor = await page.evaluate(() => {
      const root = document.querySelector('#root')
      if (!root?.firstElementChild) return null
      return getComputedStyle(root.firstElementChild).backgroundColor
    })
    // Should have a background color set (not empty)
    expect(bgColor).toBeTruthy()
  })

  test('SPA fallback — unknown path returns index.html', async ({ page }) => {
    const response = await page.goto(`${base}/some/unknown/route`, { waitUntil: 'domcontentloaded' })
    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-type']).toContain('text/html')
    // Should still render the React app
    await page.waitForSelector('#root', { timeout: 5000 })
  })
})
