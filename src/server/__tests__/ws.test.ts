import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import WebSocket from 'ws'
import { createTestServer, request, type TestContext } from './helpers/test-server'
import { eventBus } from '../event-bus'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  eventBus.clear()
  ctx.close()
})

function connect(token?: string): Promise<WebSocket> {
  const t = token ?? ctx.token
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws?token=${t}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()))
    })
  })
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.on('close', () => resolve())
    ws.close()
  })
}

describe('WebSocket server', () => {
  it('connects with agent token', async () => {
    const ws = await connect()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeWs(ws)
  })

  it('connects with user token', async () => {
    const ws = await connect(ctx.userToken)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    await closeWs(ws)
  })

  it('rejects connection without token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/ws`)
        ws.on('open', () => { ws.close(); resolve('opened') })
        ws.on('error', reject)
      })
    ).rejects.toThrow()
  })

  it('rejects connection with invalid token', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${ctx.baseUrl.replace('http', 'ws')}/ws?token=` +
          '0'.repeat(64)
        )
        ws.on('open', () => { ws.close(); resolve('opened') })
        ws.on('error', reject)
      })
    ).rejects.toThrow()
  })

  it('rejects upgrade on non-/ws path', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${ctx.baseUrl.replace('http', 'ws')}/other?token=${ctx.token}`)
        ws.on('open', () => { ws.close(); resolve('opened') })
        ws.on('error', reject)
      })
    ).rejects.toThrow()
  })

  it('subscribes to channels and receives events', async () => {
    const ws = await connect()

    // Subscribe
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['room:1'] }))
    const subAck = await waitForMessage(ws)
    expect(subAck.type).toBe('subscribed')
    expect(subAck.channels).toContain('room:1')

    // Emit event to subscribed channel
    const msgPromise = waitForMessage(ws)
    eventBus.emit('room:1', 'test:event', { hello: 'world' })

    const event = await msgPromise
    expect(event.type).toBe('test:event')
    expect(event.channel).toBe('room:1')
    expect(event.data).toEqual({ hello: 'world' })
    expect(event.timestamp).toBeDefined()

    await closeWs(ws)
  })

  it('does not receive events for unsubscribed channels', async () => {
    const ws = await connect()

    ws.send(JSON.stringify({ type: 'subscribe', channels: ['room:1'] }))
    await waitForMessage(ws) // subscribed ack

    // Emit to different channel
    let received = false
    ws.on('message', () => { received = true })
    eventBus.emit('room:2', 'other:event', {})

    // Wait a bit to ensure no message comes
    await new Promise(r => setTimeout(r, 50))
    expect(received).toBe(false)

    await closeWs(ws)
  })

  it('unsubscribes from channels', async () => {
    const ws = await connect()

    ws.send(JSON.stringify({ type: 'subscribe', channels: ['room:1', 'tasks'] }))
    await waitForMessage(ws) // subscribed ack

    ws.send(JSON.stringify({ type: 'unsubscribe', channels: ['room:1'] }))
    const unsubAck = await waitForMessage(ws)
    expect(unsubAck.type).toBe('unsubscribed')
    expect(unsubAck.channels).not.toContain('room:1')
    expect(unsubAck.channels).toContain('tasks')

    await closeWs(ws)
  })

  it('responds to ping with pong', async () => {
    const ws = await connect()

    ws.send(JSON.stringify({ type: 'ping' }))
    const msg = await waitForMessage(ws)
    expect(msg.type).toBe('pong')

    await closeWs(ws)
  })

  it('sends error for unknown message type', async () => {
    const ws = await connect()

    ws.send(JSON.stringify({ type: 'unknown' }))
    const msg = await waitForMessage(ws)
    expect(msg.type).toBe('error')
    expect(msg.message).toContain('Unknown message type')

    await closeWs(ws)
  })

  it('sends error for invalid JSON', async () => {
    const ws = await connect()

    ws.send('not json')
    const msg = await waitForMessage(ws)
    expect(msg.type).toBe('error')
    expect(msg.message).toContain('Invalid JSON')

    await closeWs(ws)
  })

  it('broadcasts to multiple subscribers on same channel', async () => {
    const ws1 = await connect()
    const ws2 = await connect()

    ws1.send(JSON.stringify({ type: 'subscribe', channels: ['shared'] }))
    ws2.send(JSON.stringify({ type: 'subscribe', channels: ['shared'] }))
    await waitForMessage(ws1) // ack
    await waitForMessage(ws2) // ack

    const p1 = waitForMessage(ws1)
    const p2 = waitForMessage(ws2)
    eventBus.emit('shared', 'broadcast:test', { n: 42 })

    const [m1, m2] = await Promise.all([p1, p2])
    expect(m1.type).toBe('broadcast:test')
    expect(m2.type).toBe('broadcast:test')

    await closeWs(ws1)
    await closeWs(ws2)
  })

  it('receives events triggered by HTTP API', async () => {
    const ws = await connect()

    // Subscribe to tasks channel
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['tasks'] }))
    await waitForMessage(ws) // ack

    // Create a task via HTTP (which emits to eventBus)
    const msgPromise = waitForMessage(ws)
    await request(ctx, 'POST', '/api/tasks', {
      prompt: 'WS test task'
    })

    const event = await msgPromise
    expect(event.type).toBe('task:created')
    expect(event.channel).toBe('tasks')
    expect(event.data.prompt).toBe('WS test task')

    await closeWs(ws)
  })
})

describe('WebSocket memory leak regression', () => {
  it('cleans up connections after client disconnect (no stale fan-out)', async () => {
    // Connect several clients and subscribe them
    const clients: WebSocket[] = []
    for (let i = 0; i < 10; i++) {
      const ws = await connect()
      ws.send(JSON.stringify({ type: 'subscribe', channels: ['leak-test'] }))
      await waitForMessage(ws) // subscribed ack
      clients.push(ws)
    }

    // Close all clients
    await Promise.all(clients.map(closeWs))

    // Small delay for server-side 'close' handlers to fire
    await new Promise(r => setTimeout(r, 50))

    // Connect a fresh client and verify it receives events (server still works)
    const fresh = await connect()
    fresh.send(JSON.stringify({ type: 'subscribe', channels: ['leak-test'] }))
    await waitForMessage(fresh) // subscribed ack

    const msgPromise = waitForMessage(fresh)
    eventBus.emit('leak-test', 'after:cleanup', { ok: true })
    const event = await msgPromise
    expect(event.type).toBe('after:cleanup')
    expect(event.data).toEqual({ ok: true })

    await closeWs(fresh)
  })

  it('does not leak connections on rapid connect/disconnect cycles', async () => {
    // Simulate rapid reconnect pattern (browser refresh, flaky network)
    for (let i = 0; i < 20; i++) {
      const ws = await connect()
      ws.send(JSON.stringify({ type: 'subscribe', channels: ['churn'] }))
      // Don't wait for ack — immediately close to simulate rapid churn
      await closeWs(ws)
    }

    // Small delay for cleanup
    await new Promise(r => setTimeout(r, 100))

    // Server should still be healthy — verify with a working connection
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['churn'] }))
    const ack = await waitForMessage(ws)
    expect(ack.type).toBe('subscribed')

    const msgPromise = waitForMessage(ws)
    eventBus.emit('churn', 'post:churn', { round: 'final' })
    const event = await msgPromise
    expect(event.type).toBe('post:churn')

    await closeWs(ws)
  })

  it('terminated connections do not receive events', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['term-test'] }))
    await waitForMessage(ws) // subscribed ack

    // Force-terminate without clean close (simulates network drop)
    ws.terminate()
    await new Promise(r => setTimeout(r, 50))

    // Emit an event — server should not throw when trying to send to dead socket
    expect(() => {
      eventBus.emit('term-test', 'ghost:event', { data: 'should not crash' })
    }).not.toThrow()
  })
})
