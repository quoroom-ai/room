/**
 * E2E: UI smoke tests — loads the React SPA, navigates tabs, takes screenshots.
 * Verifies that the frontend renders correctly when served by the API server.
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { getToken, getBaseUrl } from './helpers'

const base = getBaseUrl()
const token = getToken()

async function ensureActiveRoom(request: APIRequestContext): Promise<number> {
  const roomsRes = await request.get(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const rooms = (await roomsRes.json()) as Array<{ id: number; status: string }>
  const active = rooms.find((room) => room.status !== 'stopped')
  if (active) return active.id

  const roomName = `ui-e2e-${Date.now().toString(36)}`
  const createRes = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'UI e2e room' },
  })
  expect(createRes.ok()).toBeTruthy()
  const created = (await createRes.json()) as { room: { id: number } }
  return created.room.id
}

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
    const anyTab = page.locator('button').filter({ hasText: /Overview|Tasks|Workers|Settings|Help/i }).first()
    await anyTab.waitFor({ timeout: 10000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-02-tabs-loaded.png', fullPage: true })
  })
})

test.describe('UI — Tab navigation', () => {
  test.beforeEach(async ({ page }) => {
    const roomId = await ensureActiveRoom(page.request)
    // Enable advanced mode so Workers, Tasks, Skills, Messages tabs are visible
    await page.request.put(`${base}/api/settings/advanced_mode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { value: 'true' }
    })
    // Suppress walkthrough modal so it doesn't intercept pointer events
    await page.addInitScript(() => {
      localStorage.setItem('quoroom_walkthrough_seen', 'true')
      localStorage.setItem('quoroom_contact_prompt_seen', '1')
      localStorage.setItem('quoroom_tab', 'status')
    })
    await page.addInitScript((id) => {
      localStorage.setItem('quoroom_room', String(id))
    }, roomId)
    // Suppress update modal by stripping updateInfo from /api/status
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      delete json.updateInfo
      await route.fulfill({ json })
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    // Wait for UI to be ready
    await page.locator('button').filter({ hasText: /Overview|Workers/i }).first().waitFor({ timeout: 10000 })
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('Status/Activity tab (default)', async ({ page }) => {
    // Status panel should show cards — use getByRole for specificity
    await expect(page.getByRole('button', { name: /Workers/i }).first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: /Tasks/i }).first()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-03-status-panel.png', fullPage: true })
  })

  test('Workers tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Workers$/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/\d+ total/)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-04-workers-panel.png', fullPage: true })
  })

  test('Tasks tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Tasks$/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-05-tasks-panel.png', fullPage: true })
  })

  test('Settings tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /Global Settings/i }).first().click()
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
    await expect(page.getByRole('heading', { name: 'Goals' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-14-goals-panel.png', fullPage: true })
  })

  test('Votes tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Votes$/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-15-votes-panel.png', fullPage: true })
  })

  test('Skills tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Skills$/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-16-skills-panel.png', fullPage: true })
  })

  test('Messages tab', async ({ page }) => {
    const roomId = await ensureActiveRoom(page.request)
    const unique = `msg-${Date.now().toString(36)}`

    const workersRes = await page.request.get(`${base}/api/rooms/${roomId}/workers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(workersRes.ok()).toBeTruthy()
    const existingWorkers = await workersRes.json() as Array<{ id: number }>
    expect(existingWorkers.length).toBeGreaterThan(0)
    const queenWorkerId = existingWorkers[0].id

    const helperWorkerRes = await page.request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        name: `${unique}-helper`,
        systemPrompt: 'Support message panel e2e checks.',
        roomId,
      },
    })
    expect(helperWorkerRes.ok()).toBeTruthy()
    const helperWorker = await helperWorkerRes.json() as { id: number }

    const keeperQuestion = `${unique} keeper-visible escalation`
    const internalQuestion = `${unique} internal escalation`

    const keeperEscalationRes = await page.request.post(`${base}/api/rooms/${roomId}/escalations`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        fromAgentId: helperWorker.id,
        question: keeperQuestion,
      },
    })
    expect(keeperEscalationRes.ok()).toBeTruthy()

    const internalEscalationRes = await page.request.post(`${base}/api/rooms/${roomId}/escalations`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        fromAgentId: helperWorker.id,
        toAgentId: queenWorkerId,
        question: internalQuestion,
      },
    })
    expect(internalEscalationRes.ok()).toBeTruthy()

    await page.evaluate(() => {
      localStorage.setItem('quoroom_messages_collapsed', 'true')
      localStorage.setItem('quoroom_messages_scope', 'keeper')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('button').filter({ hasText: /Overview|Workers/i }).first().waitFor({ timeout: 10000 })

    await page.locator('button').filter({ hasText: /^Messages/i }).first().click()
    await expect(page.getByRole('button', { name: 'Show internal' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(keeperQuestion)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(internalQuestion)).toHaveCount(0)
    await expect(page.getByText('Needs reply').first()).toBeVisible({ timeout: 5000 })

    await page.getByRole('button', { name: 'Show internal' }).click()
    await expect(page.getByRole('button', { name: 'Hide internal' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(internalQuestion)).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-17-messages-panel.png', fullPage: true })
  })

  test('Transactions tab', async ({ page }) => {
    await page.locator('button').filter({ hasText: /^Transactions$/i }).first().click()
    // Transactions panel shows the heading
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'e2e/screenshots/ui-18-transactions-panel.png', fullPage: true })
  })
})

test.describe('UI — Interaction', () => {
  test.beforeEach(async ({ page }) => {
    const roomId = await ensureActiveRoom(page.request)
    // Enable advanced mode so Workers, Tasks tabs are visible
    await page.request.put(`${base}/api/settings/advanced_mode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { value: 'true' }
    })
    // Ensure all rooms are in auto mode (read-only UI) so tests are deterministic
    const roomsRes = await page.request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    for (const room of await roomsRes.json()) {
      if (room.autonomyMode !== 'auto') {
        await page.request.patch(`${base}/api/rooms/${room.id}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          data: { autonomyMode: 'auto' }
        })
      }
    }
    // Suppress walkthrough and update modals so they don't intercept pointer events
    await page.addInitScript(() => {
      localStorage.setItem('quoroom_walkthrough_seen', 'true')
      localStorage.setItem('quoroom_contact_prompt_seen', '1')
      localStorage.setItem('quoroom_tab', 'status')
    })
    await page.addInitScript((id) => {
      localStorage.setItem('quoroom_room', String(id))
    }, roomId)
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      delete json.updateInfo
      await route.fulfill({ json })
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('button').filter({ hasText: /Overview|Workers/i }).first().waitFor({ timeout: 10000 })
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('tasks panel shows read-only task list', async ({ page }) => {
    const token = getToken()

    // Find rooms and clean up leftover tasks from ALL rooms (previous runs may scatter them)
    const roomsRes = await page.request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const allRooms = (await roomsRes.json()) as Array<{ id: number; name: string; status: string }>
    // Match App.tsx selection logic: first non-stopped room
    const roomId = allRooms.filter(r => r.status !== 'stopped')[0]?.id
    for (const room of allRooms) {
      const tasksRes = await page.request.get(`${base}/api/rooms/${room.id}/tasks`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (tasksRes.ok()) {
        for (const t of await tasksRes.json()) {
          if (t.name === 'PW Read-Only Task') {
            await page.request.delete(`${base}/api/tasks/${t.id}`, {
              headers: { Authorization: `Bearer ${token}` }
            })
          }
        }
      }
    }

    // Create a task via API within the room
    const res = await page.request.post(`${base}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'PW Read-Only Task', prompt: 'Test task for e2e', roomId }
    })
    expect(res.ok()).toBeTruthy()

    // Reload so the SPA fetches fresh data including the newly created task
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('button').filter({ hasText: /Overview|Workers/i }).first().waitFor({ timeout: 10000 })

    // Navigate to Tasks tab — wait for the tasks API response before asserting
    const tasksLoaded = page.waitForResponse(
      resp => resp.url().includes('/api/tasks') && resp.request().method() === 'GET',
      { timeout: 10000 }
    )
    await page.locator('button').filter({ hasText: /^Tasks$/i }).first().click()
    await tasksLoaded

    // Task should appear in the list (read-only in auto mode, no create button)
    await expect(page.getByText('PW Read-Only Task').first()).toBeVisible({ timeout: 5000 })

    // In auto mode, create button is visible but gated by lock modal
    await expect(page.getByRole('button', { name: /New Task/i })).toBeVisible()

    await page.screenshot({ path: 'e2e/screenshots/ui-08-tasks-readonly.png', fullPage: true })
  })

  test('workers panel shows read-only worker list', async ({ page }) => {
    const token = getToken()

    // Find rooms and clean up leftover workers from ALL rooms
    const roomsRes = await page.request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const allRooms = (await roomsRes.json()) as Array<{ id: number; name: string; status: string }>
    // Match App.tsx selection logic: first non-stopped room
    const roomId = allRooms.filter(r => r.status !== 'stopped')[0]?.id
    for (const room of allRooms) {
      const workersRes = await page.request.get(`${base}/api/rooms/${room.id}/workers`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (workersRes.ok()) {
        for (const w of await workersRes.json()) {
          if (w.name === 'PW Read-Only Worker') {
            await page.request.delete(`${base}/api/workers/${w.id}`, {
              headers: { Authorization: `Bearer ${token}` }
            })
          }
        }
      }
    }

    // Create a worker via API
    const res = await page.request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'PW Read-Only Worker', systemPrompt: 'Test worker for e2e', roomId }
    })
    expect(res.ok()).toBeTruthy()

    // Reload so the SPA fetches fresh data including the newly created worker
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('button').filter({ hasText: /Overview|Workers/i }).first().waitFor({ timeout: 10000 })

    // Navigate to Workers tab
    await page.locator('div.pl-4 button').filter({ hasText: /^Workers/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible({ timeout: 5000 })

    // Worker should appear in the list
    await expect(page.getByText('PW Read-Only Worker').first()).toBeVisible({ timeout: 10000 })

    // In auto mode, create button is visible but gated by lock modal
    await expect(page.getByRole('button', { name: /New Worker/i })).toBeVisible()

    await page.screenshot({ path: 'e2e/screenshots/ui-10-workers-readonly.png', fullPage: true })
  })

  test('transactions panel shows wallet state', async ({ page }) => {
    // Navigate to Transactions tab
    await page.locator('button').filter({ hasText: /^Transactions$/i }).first().click()

    // Click a room in the sidebar to select it
    const sidebar = page.locator('[class*="sidebar"], nav, aside').first()
    const roomLink = sidebar.locator('button, a').filter({ hasText: /Room|room/i }).first()
    if (await roomLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await roomLink.click()
    }

    // Wallet panel shows empty state
    await expect(page.getByText('No transactions yet.')).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-19-transactions-subtabs.png', fullPage: true })
  })

  test('toggle advanced mode shows extra tabs', async ({ page }) => {
    // Ensure advanced mode starts OFF so toggling turns it ON
    const token = getToken()
    await page.request.put(`${base}/api/settings/advanced_mode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { value: 'false' }
    })
    // Full navigation instead of reload to ensure route handlers survive
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('button').filter({ hasText: /Overview/i }).first().waitFor({ timeout: 10000 })

    // Navigate to Global Settings
    await page.locator('button').filter({ hasText: /Global Settings/i }).first().click()
    await expect(page.getByText('Preferences')).toBeVisible({ timeout: 5000 })

    // Find and click the Advanced mode toggle (the toggle button next to "Advanced mode" text)
    const advancedRow = page.locator('text=Advanced mode').locator('..')
    await advancedRow.locator('button').first().click()

    // Advanced mode should reveal the Memory tab.
    const memoryTab = page.locator('button').filter({ hasText: /^Memory$/i }).first()
    await expect(memoryTab).toBeVisible({ timeout: 5000 })

    await page.screenshot({ path: 'e2e/screenshots/ui-12-advanced-mode.png', fullPage: true })

    // Navigate to Memory tab
    await memoryTab.click()
    await page.screenshot({ path: 'e2e/screenshots/ui-13-memory-panel.png', fullPage: true })
  })
})

test.describe('UI — Static assets', () => {
  test('CSS loads correctly', async ({ page }) => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#root', { timeout: 5000 })

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

test.describe('UI — Mobile + PWA', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const token = getToken()
    await page.request.put(`${base}/api/settings/advanced_mode`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { value: 'true' }
    })
    await page.addInitScript(() => {
      localStorage.setItem('quoroom_walkthrough_seen', 'true')
      localStorage.setItem('quoroom_contact_prompt_seen', '1')
      // Use 'settings' tab: mobile header is always visible for settings/help/clerk/swarm tabs
      localStorage.setItem('quoroom_tab', 'settings')
    })
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch()
      const json = await response.json()
      delete json.updateInfo
      await route.fulfill({ json })
    })
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('mobile header and sidebar navigation are usable', async ({ page }) => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })

    const openMenu = page.getByLabel('Open menu').first()
    await expect(openMenu).toBeVisible({ timeout: 10_000 })
    await openMenu.click()
    await expect(page.getByRole('button', { name: /^Help$/i })).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: /^Help$/i }).first().click()
    await expect(page.getByText('Getting Started')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('Install as App')).toHaveCount(0)

    await page.screenshot({ path: 'e2e/screenshots/ui-20-mobile-help.png', fullPage: true })
  })

  test('PWA endpoints are removed and responses are no-store', async ({ page }) => {
    const rootRes = await page.request.get(`${base}/`)
    expect(rootRes.ok()).toBeTruthy()
    const rootCacheControl = rootRes.headers()['cache-control'] || ''
    expect(rootCacheControl).toContain('no-cache')
    expect(rootCacheControl).toContain('no-store')
    expect(rootRes.headers()['pragma']).toBe('no-cache')
    expect(rootRes.headers()['expires']).toBe('0')

    const iconRes = await page.request.get(`${base}/favicon.ico`)
    expect(iconRes.ok()).toBeTruthy()
    const iconCacheControl = iconRes.headers()['cache-control'] || ''
    expect(iconCacheControl).toContain('no-cache')
    expect(iconCacheControl).toContain('no-store')

    const token = getToken()
    const apiStatusRes = await page.request.get(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(apiStatusRes.ok()).toBeTruthy()
    const apiCacheControl = apiStatusRes.headers()['cache-control'] || ''
    expect(apiCacheControl).toContain('no-cache')
    expect(apiCacheControl).toContain('no-store')

    const manifestRes = await page.request.get(`${base}/manifest.webmanifest`)
    expect(manifestRes.status()).toBe(404)

    const swRes = await page.request.get(`${base}/sw.js?v=e2e`)
    expect(swRes.status()).toBe(404)
  })
})
