/**
 * E2E: Room setup flow and archive safety checks.
 * Focused on browser-driven keeper flows added in Room Settings.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { getBaseUrl, getToken } from './helpers'

const base = getBaseUrl()
const token = getToken()
const ROOM_PREFIX = 'E2E Setup Flow Room'

function uniqueRoomName(label: string): string {
  return `${ROOM_PREFIX} ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function providerEntry(installed: boolean, connected: boolean | null, version?: string) {
  return {
    installed,
    version,
    connected,
    requestedAt: null,
    disconnectedAt: null,
    authSession: null,
    installRequestedAt: null,
    installSession: null,
  }
}

async function suppressBlockingModals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('quoroom_walkthrough_seen', 'true')
    localStorage.setItem('quoroom_contact_prompt_seen', '1')
    localStorage.setItem('quoroom_tab', 'swarm')
  })
  await page.route('**/api/clerk/status', async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        model: 'claude',
        commentaryEnabled: true,
        apiAuth: {
          openai: { hasRoomCredential: false, hasSavedKey: false, hasEnvKey: false, ready: false },
          anthropic: { hasRoomCredential: false, hasSavedKey: false, hasEnvKey: false, ready: false },
        },
      },
    })
  })
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    delete json.updateInfo
    await route.fulfill({ json })
  })
}

async function cleanupRoomsByPrefix(request: APIRequestContext, prefix: string): Promise<void> {
  let res: Awaited<ReturnType<APIRequestContext['get']>>
  try {
    res = await request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    return
  }
  if (!res.ok()) return
  let rooms: Array<{ id: number; name: string }>
  try {
    rooms = await res.json() as Array<{ id: number; name: string }>
  } catch {
    return
  }
  for (const room of rooms) {
    if (!room.name.startsWith(prefix)) continue
    await request.delete(`${base}/api/rooms/${room.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  }
}

async function createRoomViaUi(page: Page, roomName: string): Promise<number> {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const clerkSetupHeading = page.getByRole('heading', { name: 'Connect Your Clerk' })
  if (await clerkSetupHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close' }).first().click().catch(async () => {
      await page.keyboard.press('Escape')
    })
    await expect(clerkSetupHeading).not.toBeVisible({ timeout: 5000 })
  }
  const setupHeading = page.getByRole('heading', { name: 'Room Setup Flow' })
  if (await setupHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close' }).first().click().catch(async () => {
      await page.keyboard.press('Escape')
    })
    await expect(setupHeading).not.toBeVisible({ timeout: 5000 })
  }
  await page.locator('button').filter({ hasText: /New Room/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Create Room' })).toBeVisible({ timeout: 5000 })
  await page.locator('label:has-text("Room Name") + input').fill(roomName)
  await page.locator('label:has-text("Primary Objective") + textarea').fill('Automate setup flow validation')
  const createReq = page.waitForResponse((res) => {
    if (res.request().method() !== 'POST') return false
    return new URL(res.url()).pathname === '/api/rooms'
  })
  await page.locator('button').filter({ hasText: /^Create$/ }).last().click()
  const createRes = await createReq
  expect(createRes.status()).toBe(201)
  const body = await createRes.json() as { room?: { id?: number }; id?: number }
  const roomId = body.room?.id ?? body.id
  expect(typeof roomId).toBe('number')
  return roomId as number
}

async function openRoomSettings(page: Page, roomId: number, roomName: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem('quoroom_room', String(id))
    localStorage.setItem('quoroom_tab', 'room-settings')
    localStorage.setItem('quoroom_walkthrough_seen', 'true')
    localStorage.setItem('quoroom_contact_prompt_seen', '1')
    localStorage.removeItem('quoroom_setup_flow_room')
  }, roomId)
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  const setupGuide = page.locator('button').filter({ hasText: /Setup guide/i }).first()
  try {
    await expect(setupGuide).toBeVisible({ timeout: 6000 })
    return
  } catch {
    // Fallback if persisted app state did not jump directly to room settings.
  }

  const sidebar = page.getByTestId('sidebar')
  const roomBtn = sidebar.locator('button').filter({ hasText: roomName }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const text = await roomBtn.textContent()
  if (!text?.includes('▴')) await roomBtn.click()
  await sidebar.locator('button').filter({ hasText: /^Settings$/i }).first().click()
  await expect(setupGuide).toBeVisible({ timeout: 10000 })
}

async function ensureSetupModalOpen(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: 'Room Setup' })
  try {
    await expect(heading).toBeVisible({ timeout: 6000 })
    return
  } catch {
    // The auto-open can be skipped if local state changed; manual open is acceptable.
  }
  const setupGuide = page.locator('button').filter({ hasText: /Setup guide/i }).first()
  await expect(setupGuide).toBeVisible({ timeout: 10000 })
  await setupGuide.click()
  await expect(heading).toBeVisible({ timeout: 5000 })
}

test.beforeEach(async ({ page }) => {
  await suppressBlockingModals(page)
})

test.afterEach(async ({ request, page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  try {
    await cleanupRoomsByPrefix(request, ROOM_PREFIX)
  } catch {
    // Non-fatal cleanup failures should not fail the spec.
  }
})

test('room setup popup is accessible after room creation', async ({ page }) => {
  const roomName = uniqueRoomName('A')
  await createRoomViaUi(page, roomName)
  await ensureSetupModalOpen(page)
})

test('setup popup recommends subscription when provider is connected', async ({ page }) => {
  await page.route('**/api/providers/status', async (route) => {
    await route.fulfill({
      json: {
        claude: providerEntry(true, true, 'claude 1.0.0'),
        codex: providerEntry(false, false),
      },
    })
  })

  const roomName = uniqueRoomName('B')
  await createRoomViaUi(page, roomName)

  await ensureSetupModalOpen(page)
  const claudeCard = page.locator('button').filter({ hasText: 'Claude Subscription' }).first()
  await expect(claudeCard).toContainText('Recommended')

  await claudeCard.click()
  // The modal is single-page: selecting a subscription path shows "Apply" directly
  await expect(page.getByRole('button', { name: /Apply/i })).toBeVisible({ timeout: 5000 })
})

test('setup popup applies selected model path', async ({ page }) => {
  const roomName = uniqueRoomName('C')
  await createRoomViaUi(page, roomName)
  await ensureSetupModalOpen(page)

  await page.locator('button').filter({ hasText: 'OpenAI API' }).first().click()
  // The modal is single-page: selecting an API path shows the key input + "Apply" directly
  await expect(page.locator('input[placeholder*="API key"], input[placeholder*="Paste"]')).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('button', { name: /Apply/i })).toBeVisible()
})

test('archive uses cloud-station deletion route', async ({ page, request }) => {
  const roomName = uniqueRoomName('D').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Test archive flow' },
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json() as { room: { id: number } }).room.id

  await page.route(`**/api/rooms/${roomId}/cloud-stations`, async (route) => {
    await route.fulfill({
      json: [{
        id: 101,
        roomId: 'room-hash',
        tier: 'micro',
        stationName: 'E2E Station',
        flyAppName: null,
        flyMachineId: null,
        status: 'active',
        monthlyCost: 9,
        currentPeriodEnd: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    })
  })
  await page.route(`**/api/rooms/${roomId}/cloud-stations/101`, async (route) => {
    await route.fulfill({ json: { ok: true } })
  })

  await openRoomSettings(page, roomId, roomName)

  const deleteReq = page.waitForRequest((req) => {
    const pathname = new URL(req.url()).pathname
    return req.method() === 'DELETE' && pathname === `/api/rooms/${roomId}/cloud-stations/101`
  })
  await page.getByRole('button', { name: 'Archive Room' }).first().click()
  await expect(page.getByText(`Archive "${roomName}"?`)).toBeVisible()
  await page.keyboard.press('Enter')
  await deleteReq

  await expect.poll(async () => {
    const res = await request.get(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok()) return null
    const rooms = await res.json() as Array<{ id: number; status: string }>
    return rooms.find((room) => room.id === roomId)?.status ?? null
  }, { timeout: 15000 }).toBe('stopped')

  await page.reload({ waitUntil: 'domcontentloaded' })

  await expect.poll(async () => {
    return await page.evaluate(() => localStorage.getItem('quoroom_room'))
  }, { timeout: 15000 }).not.toBe(String(roomId))

  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.locator('button').filter({ hasText: roomName })).toHaveCount(0)
})
