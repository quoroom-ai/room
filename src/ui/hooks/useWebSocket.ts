import { useEffect, useState } from 'react'
import { wsClient, type WsMessage } from '../lib/ws'

/**
 * Subscribe to a WebSocket channel and return the last event data.
 * Use with usePolling's refresh() for instant updates:
 *   const lastEvent = useWebSocket('tasks')
 *   useEffect(() => { if (lastEvent) refresh() }, [lastEvent])
 */
export function useWebSocket<T = unknown>(channel: string): T | null {
  const [lastEvent, setLastEvent] = useState<T | null>(null)

  useEffect(() => {
    return wsClient.subscribe(channel, (event: WsMessage) => {
      setLastEvent(event.data as T)
    })
  }, [channel])

  return lastEvent
}
