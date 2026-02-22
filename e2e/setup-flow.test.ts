/**
 * E2E: Room setup flow and archive safety checks.
 * Focused on browser-driven keeper flows added in Room Settings.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { getBaseUrl, getToken } from './helpers'

const base = getBaseUrl()
const token = getToken()
const ROOM_PREFIX = 'E2E Setup Flow Room'

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
  await page.addInitScript(() => localStorage.setItem('quoroom_walkthrough_seen', 'true'))
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    delete json.updateInfo
    await route.fulfill({ json })
  })
}

async function cleanupRoomsByPrefix(request: APIRequestContext, prefix: string): Promise<void> {
  const res = await request.get(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok()) return
  const rooms = await res.json() as Array<{ id: number; name: string }>
  for (const room of rooms) {
    if (!room.name.startsWith(prefix)) continue
    await request.delete(`${base}/api/rooms/${room.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {})
  }
}

async function createRoomViaUi(page: Page, roomName: string): Promise<void> {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('button').filter({ hasText: /\+ New Room/i }).first().click()
  await page.locator('label:has-text("Room Name") + input').fill(roomName)
  await page.locator('label:has-text("Primary Objective") + textarea').fill('Automate setup flow validation')
  await page.locator('button').filter({ hasText: /^Create$/ }).last().click()
}

async function openRoomSettings(page: Page, roomName: string): Promise<void> {
  const sidebar = page.getByTestId('sidebar')
  const roomBtn = sidebar.locator('button').filter({ hasText: roomName }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const text = await roomBtn.textContent()
  if (!text?.includes('▴')) await roomBtn.click()
  await sidebar.locator('button').filter({ hasText: /^Settings$/i }).first().click()
}

test.beforeEach(async ({ page }) => {
  await suppressBlockingModals(page)
})

test.afterEach(async ({ request, page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await cleanupRoomsByPrefix(request, ROOM_PREFIX)
})

test('room setup popup appears after room creation', async ({ page }) => {
  const roomName = `${ROOM_PREFIX} A`
  await createRoomViaUi(page, roomName)
  await expect(page.getByRole('heading', { name: 'Room Setup Flow' })).toBeVisible({ timeout: 10000 })
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

  const roomName = `${ROOM_PREFIX} B`
  await createRoomViaUi(page, roomName)

  const claudeCard = page.locator('button').filter({ hasText: 'Claude Subscription' }).first()
  await expect(claudeCard).toContainText('Recommended')

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText(/switch queen model to/i)).toContainText('claude')
})

test('setup popup applies selected model path', async ({ page }) => {
  const roomName = `${ROOM_PREFIX} C`
  await createRoomViaUi(page, roomName)
  await expect(page.getByRole('heading', { name: 'Room Setup Flow' })).toBeVisible({ timeout: 10000 })

  await page.locator('button').filter({ hasText: 'OpenAI API' }).first().click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  const workerPatchReq = page.waitForRequest((req) => {
    if (req.method() !== 'PATCH') return false
    const pathname = new URL(req.url()).pathname
    if (!/^\/api\/workers\/\d+$/.test(pathname)) return false
    try {
      const body = req.postDataJSON() as Record<string, unknown>
      return body.model === 'openai:gpt-4o-mini'
    } catch {
      return false
    }
  })

  await page.getByRole('button', { name: 'Apply and Continue' }).click()
  await workerPatchReq
  await expect(page.getByRole('heading', { name: 'Room Setup Flow' })).not.toBeVisible()
})

test('archive uses cloud-station deletion route', async ({ page, request }) => {
  const roomName = `${ROOM_PREFIX} D`
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

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await openRoomSettings(page, roomName)

  page.on('dialog', (dialog) => {
    void dialog.accept()
  })

  const deleteReq = page.waitForRequest((req) => {
    const pathname = new URL(req.url()).pathname
    return req.method() === 'DELETE' && pathname === `/api/rooms/${roomId}/cloud-stations/101`
  })
  await page.getByRole('button', { name: 'Archive Room' }).click()
  await deleteReq
})
