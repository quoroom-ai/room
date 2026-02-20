import { getToken, API_BASE } from './auth'

export type WsMessage = {
  type: string
  channel: string
  data: unknown
  timestamp: string
}

type MessageHandler = (event: WsMessage) => void

class WsClient {
  private ws: WebSocket | null = null
  private channels = new Set<string>()
  private handlers = new Map<string, Set<MessageHandler>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private disposed = false

  async connect(): Promise<void> {
    // Clean up any previous socket before creating a new one
    this.cleanupSocket()
    this.disposed = false

    const token = await getToken()
    let wsUrl: string
    if (API_BASE) {
      const url = new URL(API_BASE)
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl = `${wsProtocol}//${url.host}/ws?token=${token}`
    } else {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl = `${protocol}//${location.host}/ws?token=${token}`
    }
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return // stale socket
      this.reconnectDelay = 1000
      if (this.channels.size > 0) {
        ws.send(JSON.stringify({ type: 'subscribe', channels: [...this.channels] }))
      }
    }

    ws.onmessage = (e) => {
      if (this.ws !== ws) return // stale socket
      try {
        const msg: WsMessage = JSON.parse(e.data)
        const channelHandlers = this.handlers.get(msg.channel)
        if (channelHandlers) {
          for (const h of channelHandlers) h(msg)
        }
        const wildcardHandlers = this.handlers.get('*')
        if (wildcardHandlers) {
          for (const h of wildcardHandlers) h(msg)
        }
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // stale socket
      // Null out handlers on the dead socket to break closure references
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      this.ws = null

      if (!this.disposed) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
      }
    }

    ws.onerror = () => {
      if (this.ws !== ws) return // stale socket
      ws.close()
    }
  }

  subscribe(channel: string, handler: MessageHandler): () => void {
    this.channels.add(channel)
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', channels: [channel] }))
    }

    return () => {
      set!.delete(handler)
      if (set!.size === 0) {
        this.handlers.delete(channel)
        this.channels.delete(channel)
        // Notify server of unsubscribe to reduce fan-out
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'unsubscribe', channels: [channel] }))
        }
      }
    }
  }

  disconnect(): void {
    this.disposed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.cleanupSocket()
  }

  /** Close and dereference the current socket, clearing all handlers */
  private cleanupSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
      this.ws = null
    }
  }
}

export const wsClient = new WsClient()
