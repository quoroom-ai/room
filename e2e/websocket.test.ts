/**
 * E2E: WebSocket tested from a real browser.
 * Subscribes to channels, triggers HTTP mutations, captures live events.
 */

import { test, expect } from '@playwright/test'
import {
  getToken, getBaseUrl,
  injectTestUI, addResult, addSummary, browserFetch
} from './helpers'

const token = getToken()

test('WebSocket — subscribe, receive live events', async ({ page }) => {
  await injectTestUI(page, 'WebSocket — Live Event Streaming')
  let passed = 0, failed = 0

  function check(ok: boolean) { if (ok) passed++; else failed++ }

  // Run entire WS test flow inside the browser
  const result = await page.evaluate(async ({ base, token }) => {
    const log: Array<{ step: string; ok: boolean; data: any }> = []

    // 1. Connect WebSocket
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`)
      socket.onopen = () => resolve(socket)
      socket.onerror = () => reject(new Error('WS connect failed'))
      setTimeout(() => reject(new Error('WS connect timeout')), 5000)
    })
    log.push({ step: 'Connect', ok: true, data: 'WebSocket connected' })

    // Helper: wait for next WS message
    function waitMsg(): Promise<any> {
      return new Promise((resolve) => {
        ws.addEventListener('message', (e) => {
          resolve(JSON.parse(e.data))
        }, { once: true })
      })
    }

    // 2. Subscribe to channels
    const subPromise = waitMsg()
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['room:1', 'tasks', 'memory'] }))
    const subAck = await subPromise
    log.push({ step: 'Subscribe', ok: subAck.type === 'subscribed', data: subAck })

    // 3. Ping/pong
    const pongPromise = waitMsg()
    ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await pongPromise
    log.push({ step: 'Ping/Pong', ok: pong.type === 'pong', data: pong })

    // 4. Trigger task creation via HTTP → expect WS event
    const taskEventPromise = waitMsg()
    const taskRes = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'WS e2e test', name: 'WS Task' })
    })
    const taskEvent = await taskEventPromise
    log.push({
      step: 'HTTP→WS (task:created)',
      ok: taskEvent.type === 'task:created' && taskEvent.channel === 'tasks',
      data: { type: taskEvent.type, channel: taskEvent.channel, taskName: taskEvent.data?.name }
    })

    // 5. Trigger memory entity creation → expect WS event
    const memEventPromise = waitMsg()
    await fetch(`${base}/api/memory/entities`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WS Test Entity', type: 'fact' })
    })
    const memEvent = await memEventPromise
    log.push({
      step: 'HTTP→WS (entity:created)',
      ok: memEvent.type === 'entity:created' && memEvent.channel === 'memory',
      data: { type: memEvent.type, channel: memEvent.channel, entityName: memEvent.data?.name }
    })

    // 6. Unsubscribe from tasks
    const unsubPromise = waitMsg()
    ws.send(JSON.stringify({ type: 'unsubscribe', channels: ['tasks'] }))
    const unsubAck = await unsubPromise
    log.push({
      step: 'Unsubscribe',
      ok: unsubAck.type === 'unsubscribed' && !unsubAck.channels.includes('tasks'),
      data: unsubAck
    })

    ws.close()
    return log
  }, { base: getBaseUrl(), token })

  // Render results to the page
  for (const r of result) {
    check(r.ok)
    await addResult(page, r.step, r.ok ? 200 : 500, r.data, 200)
  }

  await addSummary(page, passed, failed)
  await page.screenshot({ path: 'e2e/screenshots/ws-01-events.png', fullPage: true })

  expect(failed).toBe(0)
})
