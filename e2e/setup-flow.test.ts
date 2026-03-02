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

test('room runtime control is top-level and uses room start/stop endpoints', async ({ page, request }) => {
  const roomName = uniqueRoomName('Runtime').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Test room runtime controls' },
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json() as { room: { id: number } }).room.id

  const stopBeforeOpen = await request.post(`${base}/api/rooms/${roomId}/stop`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(stopBeforeOpen.ok()).toBe(true)

  let startCalls = 0
  let stopCalls = 0
  let deprecatedQueenCalls = 0
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    const pathname = new URL(req.url()).pathname
    if (pathname === `/api/rooms/${roomId}/start`) {
      startCalls += 1
      return
    }
    if (pathname === `/api/rooms/${roomId}/stop`) {
      stopCalls += 1
      return
    }
    if (pathname === `/api/rooms/${roomId}/queen/start` || pathname === `/api/rooms/${roomId}/queen/stop`) {
      deprecatedQueenCalls += 1
    }
  })

  await openRoomSettings(page, roomId, roomName)

  const runtimeHeading = page.getByRole('heading', { name: 'Room Runtime' })
  const runtimeSection = runtimeHeading.locator('xpath=..')
  const queenHeading = page.getByRole('heading', { name: 'Queen' }).first()
  const roomNameLabel = page.getByText('Room Name', { exact: true }).first()

  await expect(runtimeHeading).toBeVisible()
  await expect(queenHeading).toBeVisible()
  await expect(roomNameLabel).toBeVisible()
  await expect(page.getByText('Controls the full room runtime (queen + workers).')).toBeVisible()

  const runtimeBox = await runtimeHeading.boundingBox()
  const roomNameBox = await roomNameLabel.boundingBox()
  const queenBox = await queenHeading.boundingBox()
  expect(runtimeBox).not.toBeNull()
  expect(roomNameBox).not.toBeNull()
  expect(queenBox).not.toBeNull()
  expect((runtimeBox as NonNullable<typeof runtimeBox>).y).toBeLessThan((roomNameBox as NonNullable<typeof roomNameBox>).y)
  expect((runtimeBox as NonNullable<typeof runtimeBox>).y).toBeLessThan((queenBox as NonNullable<typeof queenBox>).y)

  const startRoomButton = runtimeSection.getByRole('button', { name: 'Start Room' })
  const stopRoomButton = runtimeSection.getByRole('button', { name: 'Stop Room' })

  await expect(startRoomButton).toHaveCount(1)
  await startRoomButton.click()
  await expect.poll(() => startCalls, { timeout: 10000 }).toBeGreaterThan(0)

  await expect(stopRoomButton).toHaveCount(1)
  await expect.poll(async () => {
    if (stopCalls > 0) return stopCalls
    try {
      await stopRoomButton.click({ timeout: 1500 })
    } catch {
      // Button can re-render while runtime transitions; retry until request is seen.
    }
    return stopCalls
  }, { timeout: 10000, intervals: [250, 500, 1000] }).toBeGreaterThan(0)

  await expect(startRoomButton).toHaveCount(1)
  await expect.poll(() => deprecatedQueenCalls, { timeout: 10000 }).toBe(0)
})

test('archive flow does not call cloud-station routes', async ({ page, request }) => {
  const roomName = uniqueRoomName('D').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Test archive flow' },
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json() as { room: { id: number } }).room.id

  let calledCloudStationRoute = false
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname
    if (pathname.includes(`/api/rooms/${roomId}/cloud-stations`)) {
      calledCloudStationRoute = true
    }
  })

  await openRoomSettings(page, roomId, roomName)
  await page.getByRole('button', { name: 'Archive Room' }).first().click()
  await expect(page.getByText(`Archive "${roomName}"?`)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(() => calledCloudStationRoute).toBe(false)

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
