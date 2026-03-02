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

function buildLocalStatus(opts?: {
  blockers?: string[]
  warnings?: string[]
  runtimeReady?: boolean
  runtimeInstalled?: boolean
  runtimeDaemonReachable?: boolean
  runtimeModelAvailable?: boolean
  memUsedPct?: number
}) {
  const blockers = opts?.blockers ?? []
  const warnings = opts?.warnings ?? []
  const runtimeReady = opts?.runtimeReady ?? false
  const runtimeInstalled = opts?.runtimeInstalled ?? false
  const runtimeDaemonReachable = opts?.runtimeDaemonReachable ?? runtimeReady
  const runtimeModelAvailable = opts?.runtimeModelAvailable ?? runtimeReady

  return {
    deploymentMode: 'local',
    modelId: 'ollama:qwen3-coder:30b',
    modelTag: 'qwen3-coder:30b',
    supported: blockers.length === 0,
    ready: blockers.length === 0 && runtimeReady,
    blockers,
    warnings,
    requirements: {
      minRamGb: 48,
      minFreeDiskGb: 30,
      minCpuCores: 8,
      maxMemUsedPct: 80,
      maxCpuLoadRatio: 0.85,
      minDarwinMajor: 23,
      minWindowsBuild: 19045,
    },
    system: {
      platform: 'darwin',
      osRelease: '25.3.0',
      cpuCount: 12,
      loadAvg1m: 2.5,
      loadRatio: 0.21,
      memTotalGb: 96,
      memFreeGb: 72,
      memUsedPct: opts?.memUsedPct ?? 25,
      diskFreeGb: 256,
    },
    runtime: {
      installed: runtimeInstalled,
      version: runtimeInstalled ? '0.6.0' : null,
      daemonReachable: runtimeDaemonReachable,
      modelAvailable: runtimeModelAvailable,
      ready: runtimeReady,
      error: runtimeReady ? null : (runtimeInstalled ? 'model "qwen3-coder:30b" is not installed' : 'ollama is not installed'),
    },
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
  await expect.poll(async () => {
    return await sidebar.getByText('Loading rooms...').count()
  }, { timeout: 15000, intervals: [250, 500, 1000] }).toBe(0)

  let roomBtn = sidebar.locator('button').filter({ hasText: roomName }).first()
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await roomBtn.count()) break
    await page.waitForTimeout(600)
    await page.reload({ waitUntil: 'domcontentloaded' })
    roomBtn = sidebar.locator('button').filter({ hasText: roomName }).first()
  }
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

test('setup popup blocks local model install/apply when compatibility fails', async ({ page }) => {
  const blockers = [
    'At least 48GB RAM required (detected 32GB).',
    'Current RAM load too high (89% used). Must be <= 80%.',
  ]

  await page.route('**/api/local-model/status', async (route) => {
    await route.fulfill({ json: buildLocalStatus({ blockers, memUsedPct: 89 }) })
  })
  await page.route('**/api/local-model/install-session', async (route) => {
    await route.fulfill({ json: { session: null } })
  })

  const roomName = uniqueRoomName('LocalBlocked')
  await createRoomViaUi(page, roomName)
  await ensureSetupModalOpen(page)

  await page.locator('button').filter({ hasText: 'Free Local (Qwen3 Coder 30B)' }).first().click()

  await expect(page.getByText('Compatibility Check (required)')).toBeVisible({ timeout: 5000 })
  await expect(page.getByText(blockers[0])).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Install Ollama + Pull Model' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Apply to Queen + Clerk + Workers' })).toBeDisabled()
})

test('workers install free model opens local installer flow', async ({ page, request }) => {
  await page.route('**/api/local-model/status', async (route) => {
    await route.fulfill({
      json: buildLocalStatus({
        blockers: [],
        runtimeReady: false,
        runtimeInstalled: false,
        runtimeDaemonReachable: false,
        runtimeModelAvailable: false,
      }),
    })
  })
  await page.route('**/api/local-model/install-session', async (route) => {
    await route.fulfill({ json: { session: null } })
  })

  const roomName = uniqueRoomName('Workers').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Open local installer flow from workers section' },
  })
  expect(create.status()).toBe(201)
  const roomId = (await create.json() as { room: { id: number } }).room.id

  await openRoomSettings(page, roomId, roomName)
  await page.getByRole('button', { name: 'Install Free Model' }).click()

  await expect(page.getByRole('heading', { name: 'Room Setup' })).toBeVisible({ timeout: 5000 })
  await expect(page.getByText('Compatibility Check (required)')).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Install Ollama + Pull Model' })).toBeVisible({ timeout: 5000 })
})

test('workers can use free local model while queen stays on paid model', async ({ page, request }) => {
  const roomName = uniqueRoomName('WorkersLocalOnly').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Allow workers to use local model independently' },
  })
  expect(create.status()).toBe(201)
  const created = await create.json() as { room: { id: number }; queen: { id: number } }
  const roomId = created.room.id
  await request.patch(`${base}/api/workers/${created.queen.id}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { model: 'codex' },
  })

  await openRoomSettings(page, roomId, roomName)

  const workersSection = page.getByRole('heading', { name: 'Workers' }).locator('xpath=..')
  const modelSelect = workersSection.getByRole('combobox').first()
  await modelSelect.click()
  await page.getByRole('option', { name: 'Free Local (Qwen3 Coder 30B)' }).click()

  await expect.poll(async () => {
    const roomRes = await request.get(`${base}/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!roomRes.ok()) return null
    return (await roomRes.json() as { workerModel: string }).workerModel
  }, { timeout: 10000 }).toBe('ollama:qwen3-coder:30b')

  await expect.poll(async () => {
    const queenRes = await request.get(`${base}/api/rooms/${roomId}/queen`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!queenRes.ok()) return null
    return (await queenRes.json() as { model: string | null }).model
  }, { timeout: 10000 }).toBe('codex')
})

test('queen falls back to free local when paid switch fails and workers are free local', async ({ page, request }) => {
  const roomName = uniqueRoomName('QueenFallback').toLowerCase().replace(/\s+/g, '-')
  const create = await request.post(`${base}/api/rooms`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name: roomName, goal: 'Fallback to local model on paid switch failure' },
  })
  expect(create.status()).toBe(201)
  const created = await create.json() as { room: { id: number }; queen: { id: number } }
  const roomId = created.room.id
  const queenId = created.queen.id

  await request.patch(`${base}/api/workers/${queenId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { model: 'ollama:qwen3-coder:30b' },
  })
  await request.patch(`${base}/api/rooms/${roomId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { workerModel: 'ollama:qwen3-coder:30b' },
  })

  await page.route(`**/api/workers/${queenId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      let model: string | null | undefined
      try {
        model = (route.request().postDataJSON() as { model?: string | null }).model
      } catch {
        model = undefined
      }
      if (model === 'openai:gpt-4o-mini') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Paid model failed' }),
        })
        return
      }
    }
    await route.fallback()
  })

  await openRoomSettings(page, roomId, roomName)

  const queenModelSelect = page.getByRole('combobox').first()
  await expect(queenModelSelect).toBeVisible({ timeout: 5000 })
  await expect(queenModelSelect).toContainText(/Free Local \(Qwen3 Coder 30B\)|Current: qwen3-coder:30b/, { timeout: 5000 })

  await queenModelSelect.click()
  await page.getByRole('option', { name: 'GPT-4o mini (API)' }).click()

  await expect(page.getByText(/Switched Queen back to Free Local\./i)).toBeVisible({ timeout: 5000 })
  await expect(queenModelSelect).toContainText('Free Local (Qwen3 Coder 30B)', { timeout: 5000 })

  await expect.poll(async () => {
    const queenRes = await request.get(`${base}/api/rooms/${roomId}/queen`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!queenRes.ok()) return null
    return (await queenRes.json() as { model: string | null }).model
  }, { timeout: 10000 }).toBe('ollama:qwen3-coder:30b')
})

test('clerk setup local model path installs and applies to all roles', async ({ page }) => {
  let runtimeReady = false
  let installCalls = 0
  let applyAllCalls = 0

  await page.unroute('**/api/clerk/status').catch(() => {})
  await page.route('**/api/clerk/status', async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        model: runtimeReady ? 'ollama:qwen3-coder:30b' : 'claude',
        commentaryEnabled: true,
        commentaryMode: 'auto',
        commentaryPace: 'light',
        apiAuth: {
          openai: { hasRoomCredential: false, hasSavedKey: false, hasEnvKey: false, ready: false, maskedKey: null },
          anthropic: { hasRoomCredential: false, hasSavedKey: false, hasEnvKey: false, ready: false, maskedKey: null },
          gemini: { hasRoomCredential: false, hasSavedKey: false, hasEnvKey: false, ready: false, maskedKey: null },
        },
      },
    })
  })

  await page.route('**/api/local-model/status', async (route) => {
    await route.fulfill({
      json: buildLocalStatus({
        blockers: [],
        runtimeReady,
        runtimeInstalled: runtimeReady,
        runtimeDaemonReachable: runtimeReady,
        runtimeModelAvailable: runtimeReady,
      }),
    })
  })
  await page.route('**/api/local-model/install-session', async (route) => {
    await route.fulfill({ json: { session: null } })
  })
  await page.route('**/api/local-model/install', async (route) => {
    installCalls += 1
    runtimeReady = true
    await route.fulfill({
      json: {
        ok: true,
        status: 'pending',
        reused: false,
        channel: 'local-model-install:session-1',
        session: {
          sessionId: 'session-1',
          status: 'completed',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          active: false,
          exitCode: 0,
          lines: [{ id: 1, stream: 'system', text: 'Local model ready: qwen3-coder:30b.', timestamp: new Date().toISOString() }],
        },
      },
    })
  })
  await page.route('**/api/local-model/apply-all', async (route) => {
    applyAllCalls += 1
    await route.fulfill({
      json: {
        modelId: 'ollama:qwen3-coder:30b',
        clerkModelBefore: 'claude',
        clerkModelAfter: 'ollama:qwen3-coder:30b',
        queenDefaultBefore: 'claude',
        queenDefaultAfter: 'ollama:qwen3-coder:30b',
        activeRoomsUpdated: 0,
        rooms: [],
      },
    })
  })

  await page.addInitScript(() => {
    localStorage.setItem('quoroom_tab', 'clerk')
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Clerk Setup' }).click()

  await expect(page.getByRole('heading', { name: 'Connect Your Clerk' })).toBeVisible({ timeout: 5000 })
  await page.locator('button').filter({ hasText: 'Free Local (Qwen3 Coder 30B)' }).first().click()
  await expect(page.getByText('Compatibility Check (required)')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: 'Install Ollama + Pull Model' }).click()
  await expect.poll(() => installCalls, { timeout: 10000 }).toBe(1)
  await expect(page.getByText('Progress')).toBeVisible({ timeout: 5000 })
  await expect(page.getByText('100%')).toBeVisible({ timeout: 5000 })

  const connectAllButton = page.getByRole('button', { name: 'Connect Clerk (Apply All)' })
  await expect(connectAllButton).toBeEnabled({ timeout: 5000 })
  await connectAllButton.click()
  await expect.poll(() => applyAllCalls, { timeout: 10000 }).toBe(1)
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
