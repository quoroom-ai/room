/**
 * WebSocket server for live event streaming.
 *
 * Protocol:
 * - Client connects: ws://localhost:PORT/ws?token=<token>
 * - Client sends: { type: 'subscribe', channels: ['room:1', 'tasks'] }
 * - Client sends: { type: 'unsubscribe', channels: ['room:1'] }
 * - Server pushes: { type: 'agent:state_changed', channel: 'room:1', data: {...}, timestamp: '...' }
 * - Server sends: { type: 'error', message: '...' } on protocol errors
 */

import type http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { validateToken } from './auth'
import { eventBus, type WsEvent } from './event-bus'

interface ClientState {
  channels: Set<string>
  isAlive: boolean
}

/** Heartbeat interval to detect dead connections (30s) */
const HEARTBEAT_INTERVAL_MS = 30_000

export function createWsServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Map<WebSocket, ClientState>()

  // Handle upgrade requests with token auth
  const upgradeHandler = (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(req.url!, `http://${req.headers.host || 'localhost'}`)

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const token = url.searchParams.get('token')
    if (!validateToken(token ? `Bearer ${token}` : undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }
  server.on('upgrade', upgradeHandler)

  // Handle new connections
  wss.on('connection', (ws) => {
    const state: ClientState = { channels: new Set(), isAlive: true }
    clients.set(ws, state)

    ws.on('pong', () => {
      state.isAlive = true
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleClientMessage(ws, state, msg)
      } catch {
        sendError(ws, 'Invalid JSON')
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
    })

    ws.on('error', () => {
      clients.delete(ws)
      ws.terminate()
    })
  })

  // Heartbeat: ping all clients, terminate unresponsive ones
  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.isAlive) {
        // Client didn't respond to last ping — dead connection
        clients.delete(ws)
        ws.terminate()
        continue
      }
      state.isAlive = false
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  // Fan out events to subscribed clients
  const unsub = eventBus.onAny((event: WsEvent) => {
    const payload = JSON.stringify(event)
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) {
        // Eagerly clean up connections that aren't open
        clients.delete(ws)
        continue
      }
      if (state.channels.has(event.channel)) {
        ws.send(payload)
      }
    }
  })

  // Cleanup on close — remove all listeners, timers, and connections
  wss.on('close', () => {
    clearInterval(heartbeat)
    unsub()
    server.removeListener('upgrade', upgradeHandler)
    for (const [ws] of clients) {
      ws.terminate()
    }
    clients.clear()
  })

  return wss
}

function handleClientMessage(
  ws: WebSocket,
  state: ClientState,
  msg: { type: string; channels?: string[] }
): void {
  if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
    for (const ch of msg.channels) {
      if (typeof ch === 'string') state.channels.add(ch)
    }
    ws.send(JSON.stringify({
      type: 'subscribed',
      channels: [...state.channels]
    }))
    return
  }

  if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
    for (const ch of msg.channels) {
      state.channels.delete(ch)
    }
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      channels: [...state.channels]
    }))
    return
  }

  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }))
    return
  }

  sendError(ws, `Unknown message type: ${msg.type}`)
}

function sendError(ws: WebSocket, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }))
  }
}
