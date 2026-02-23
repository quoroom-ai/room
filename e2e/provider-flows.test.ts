/**
 * E2E: Provider connect/disconnect and wallet onramp flows.
 * Uses route interception to mock server responses — no real CLI needed.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { getBaseUrl, getToken } from './helpers'

const base = getBaseUrl()
const token = getToken()
const ROOM_PREFIX = 'E2E Provider Flow Room'

function uniqueRoomName(label: string): string {
  return `${ROOM_PREFIX} ${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function providerEntry(installed: boolean, connected: boolean | null, version?: string) {
  return {
    installed,
    version: version ?? null,
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
    rooms = (await res.json()) as Array<{ id: number; name: string }>
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

async function createRoomApi(request: APIRequestContext, name: string): Promise<number> {
  const res = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name, goal: 'Provider flow test' },
  })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { room: { id: number } }).room.id
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
  if (!text?.includes('\u25B4')) await roomBtn.click()
  await sidebar.locator('button').filter({ hasText: /^Settings$/i }).first().click()
  await expect(setupGuide).toBeVisible({ timeout: 10000 })
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

// ─── Provider Connect ────────────────────────────────────────────────

test('provider connect sends POST to correct endpoint', async ({ page, request }) => {
  const roomName = uniqueRoomName('Connect')
  const roomId = await createRoomApi(request, roomName)

  // Mock provider status: claude installed but not connected
  await page.route('**/api/providers/status', async (route) => {
    await route.fulfill({
      json: {
        claude: providerEntry(true, false, 'claude 1.0.0'),
        codex: providerEntry(false, false),
      },
    })
  })

  // Find the queen worker and set model to claude so provider state row appears.
  const workersRes = await request.get(`${base}/api/rooms/${roomId}/workers`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const workers = (await workersRes.json()) as Array<{ id: number; role: string }>
  const queen = workers.find(w => w.role === 'queen')
  if (queen) {
    await request.patch(`${base}/api/workers/${queen.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { model: 'claude' },
    })
  }

  // Mock the connect endpoint
  await page.route('**/api/providers/claude/connect', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        provider: 'claude',
        status: 'pending',
        requestedAt: new Date().toISOString(),
        reused: false,
        session: { sessionId: 'test-session-1', status: 'pending', active: true },
        channel: 'provider-auth:test-session-1',
      },
    })
  })

  await openRoomSettings(page, roomId, roomName)

  // Wait for queen status to load and show Claude status
  await expect(page.getByText('Claude disconnected')).toBeVisible({ timeout: 10000 })

  const connectReq = page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/providers/claude/connect'
  )
  await page.locator('button').filter({ hasText: /^Connect$/ }).first().click()
  await connectReq
})

// ─── Provider Disconnect ─────────────────────────────────────────────

test('provider disconnect sends POST to correct endpoint', async ({ page, request }) => {
  const roomName = uniqueRoomName('Disconnect')
  const roomId = await createRoomApi(request, roomName)

  // Mock provider status: claude installed and connected
  await page.route('**/api/providers/status', async (route) => {
    await route.fulfill({
      json: {
        claude: providerEntry(true, true, 'claude 1.0.0'),
        codex: providerEntry(false, false),
      },
    })
  })

  // Set queen model to claude
  const workersRes = await request.get(`${base}/api/rooms/${roomId}/workers`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const workers = (await workersRes.json()) as Array<{ id: number; role: string }>
  const queen = workers.find(w => w.role === 'queen')
  if (queen) {
    await request.patch(`${base}/api/workers/${queen.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { model: 'claude' },
    })
  }

  // Mock the disconnect endpoint
  await page.route('**/api/providers/claude/disconnect', async (route) => {
    await route.fulfill({
      json: { ok: true, provider: 'claude', status: 'disconnected', disconnectedAt: new Date().toISOString() },
    })
  })

  await openRoomSettings(page, roomId, roomName)

  await expect(page.getByText('Claude connected')).toBeVisible({ timeout: 10000 })

  const disconnectReq = page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/providers/claude/disconnect'
  )
  await page.locator('button').filter({ hasText: /^Disconnect$/ }).first().click()
  await disconnectReq
})

// ─── Wallet Onramp URL ───────────────────────────────────────────────

test('wallet top-up link points to onramp redirect', async ({ page, request }) => {
  const roomName = uniqueRoomName('Onramp')
  const roomId = await createRoomApi(request, roomName)

  // Mock wallet endpoint to return a wallet with an address
  await page.route(`**/api/rooms/${roomId}/wallet`, async (route) => {
    await route.fulfill({
      json: {
        id: 1,
        roomId,
        address: '0xTestAddress',
        chain: 'base',
        erc8004AgentId: null,
        createdAt: new Date().toISOString(),
      },
    })
  })

  // Mock balance endpoint
  await page.route(`**/api/rooms/${roomId}/wallet/balance`, async (route) => {
    await route.fulfill({
      json: {
        totalBalance: 5.0,
        byChain: { base: { usdc: 5.0, usdt: 0, total: 5.0 } },
        address: '0xTestAddress',
        fetchedAt: new Date().toISOString(),
      },
    })
  })

  // Mock summary endpoint
  await page.route(`**/api/rooms/${roomId}/wallet/summary`, async (route) => {
    await route.fulfill({
      json: { totalIncome: 10.0, totalExpenses: 5.0, netProfit: 5.0 },
    })
  })

  await openRoomSettings(page, roomId, roomName)

  // Find the "Top Up from Card" link in the wallet section
  const topUpLink = page.locator('a').filter({ hasText: 'Top Up from Card' }).first()
  await expect(topUpLink).toBeVisible({ timeout: 10000 })

  const href = await topUpLink.getAttribute('href')
  expect(href).toContain(`/api/rooms/${roomId}/wallet/onramp-redirect`)
  expect(href).toContain('token=')
})
