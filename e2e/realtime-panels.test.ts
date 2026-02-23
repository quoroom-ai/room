/**
 * E2E regressions for realtime panel updates.
 * Covers:
 * 1) room switch while a room-scoped request is in-flight
 * 2) socket-driven refresh for Goals/Votes/Skills/Credentials
 */

import { test, expect, type Page } from '@playwright/test'
import { getBaseUrl, getToken } from './helpers'

const base = getBaseUrl()
const token = getToken()

async function waitForReady(page: Page): Promise<void> {
  await page.locator('button').filter({ hasText: /Settings|Help/i }).first().waitFor({ timeout: 10000 })
}

function sidebar(page: Page) {
  return page.getByTestId('sidebar')
}

async function expandRoom(page: Page, roomName: string): Promise<void> {
  const roomBtn = sidebar(page).locator('button').filter({ hasText: roomName }).first()
  await roomBtn.waitFor({ timeout: 10000 })
  const txt = await roomBtn.textContent()
  if (!txt?.includes('▴')) {
    await roomBtn.click()
  }
}

async function clickTab(page: Page, tabLabel: string): Promise<void> {
  await sidebar(page).locator('button').filter({ hasText: new RegExp(`^${tabLabel}$`) }).click()
}

async function initPage(page: Page): Promise<void> {
  await page.request.put(`${base}/api/settings/advanced_mode`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { value: 'true' },
  })
  await page.addInitScript(() => {
    localStorage.removeItem('quoroom_tab')
    localStorage.removeItem('quoroom_room')
    localStorage.setItem('quoroom_walkthrough_seen', 'true')
    localStorage.setItem('quoroom_contact_prompt_seen', '1')
  })
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    delete json.updateInfo
    await route.fulfill({ json })
  })
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await waitForReady(page)
}

test.describe('Realtime panel updates', () => {
  let roomAId = 0
  let roomBId = 0
  let roomRealtimeId = 0
  let roomAName = ''
  let roomBName = ''
  let roomRealtimeName = ''
  let workerAName = ''
  let workerBName = ''

  test.beforeAll(async ({ request }) => {
    const suffix = Date.now()
    roomAName = `Realtime Switch Room A ${suffix}`
    roomBName = `Realtime Switch Room B ${suffix}`
    roomRealtimeName = `Realtime Panels Room ${suffix}`
    workerAName = `Worker A ${suffix}`
    workerBName = `Worker B ${suffix}`

    const a = await request.post(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: roomAName, goal: 'Switch test A' },
    })
    const b = await request.post(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: roomBName, goal: 'Switch test B' },
    })
    const c = await request.post(`${base}/api/rooms`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: roomRealtimeName, goal: 'Realtime panel test' },
    })
    roomAId = (await a.json()).room.id
    roomBId = (await b.json()).room.id
    roomRealtimeId = (await c.json()).room.id

    await request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: workerAName, systemPrompt: 'A', roomId: roomAId },
    })
    await request.post(`${base}/api/workers`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: workerBName, systemPrompt: 'B', roomId: roomBId },
    })
  })

  test.afterAll(async ({ request }) => {
    for (const id of [roomAId, roomBId, roomRealtimeId]) {
      if (!id) continue
      await request.delete(`${base}/api/rooms/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  test('switching rooms during in-flight fetch shows correct room data', async ({ page }) => {
    await page.route(`**/api/rooms/${roomAId}/workers*`, async (route) => {
      // Simulate slow request for room A to force an in-flight overlap.
      await new Promise((resolve) => setTimeout(resolve, 1600))
      await route.continue()
    })

    await initPage(page)

    await expandRoom(page, roomAName)
    await clickTab(page, 'Workers')

    await expandRoom(page, roomBName)
    await clickTab(page, 'Workers')

    await expect(page.getByText(workerBName)).toBeVisible({ timeout: 6000 })
    await expect(page.getByText(workerAName)).not.toBeVisible()
  })

  test('goals, votes, skills, credentials refresh from websocket events', async ({ page, request }) => {
    const suffix = Date.now()
    const goalText = `Realtime Goal ${suffix}`
    const proposalText = `Realtime Decision ${suffix}`
    const skillName = `Realtime Skill ${suffix}`
    const credentialName = `realtime_credential_${suffix}`

    await initPage(page)
    await expandRoom(page, roomRealtimeName)

    await clickTab(page, 'Goals')
    await expect(page.getByText(goalText)).toHaveCount(0)
    await request.post(`${base}/api/rooms/${roomRealtimeId}/goals`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { description: goalText },
    })
    await expect(page.getByText(goalText)).toBeVisible({ timeout: 5000 })

    await clickTab(page, 'Votes')
    await expect(page.getByText(proposalText)).toHaveCount(0)
    await request.post(`${base}/api/rooms/${roomRealtimeId}/decisions`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { proposal: proposalText, decisionType: 'strategy' },
    })
    await expect(page.getByText(proposalText)).toBeVisible({ timeout: 5000 })

    await clickTab(page, 'Skills')
    await expect(page.getByText(skillName)).toHaveCount(0)
    await request.post(`${base}/api/skills`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { roomId: roomRealtimeId, name: skillName, content: 'Realtime skill content' },
    })
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 5000 })

    await clickTab(page, 'Credentials')
    await expect(page.getByText(credentialName)).toHaveCount(0)
    await request.post(`${base}/api/rooms/${roomRealtimeId}/credentials`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: credentialName, value: 'sk-test-realtime', type: 'api_key' },
    })
    await expect(page.getByText(credentialName)).toBeVisible({ timeout: 5000 })
  })
})
