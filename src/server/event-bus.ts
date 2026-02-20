/**
 * Pub/sub event bus for WebSocket fan-out.
 *
 * Route handlers and the agent loop emit events to the bus.
 * The WebSocket server subscribes and fans out to connected clients
 * based on their channel subscriptions.
 */

export interface WsEvent {
  type: string
  channel: string
  data: unknown
  timestamp: string
}

type EventHandler = (event: WsEvent) => void

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()
  private wildcardHandlers = new Set<EventHandler>()

  emit(channel: string, type: string, data: unknown): void {
    const event: WsEvent = {
      type,
      channel,
      data,
      timestamp: new Date().toISOString()
    }

    // Channel-specific handlers
    const channelHandlers = this.handlers.get(channel)
    if (channelHandlers) {
      for (const handler of channelHandlers) handler(event)
    }

    // Wildcard handlers (used by WebSocket fan-out)
    for (const handler of this.wildcardHandlers) handler(event)
  }

  on(channel: string, handler: EventHandler): () => void {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.handlers.delete(channel)
    }
  }

  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler)
    return () => {
      this.wildcardHandlers.delete(handler)
    }
  }

  /** Remove all handlers (useful for tests) */
  clear(): void {
    this.handlers.clear()
    this.wildcardHandlers.clear()
  }
}

export const eventBus = new EventBus()
