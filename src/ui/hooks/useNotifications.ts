import { useEffect, useRef } from 'react'
import { wsClient, type WsMessage } from '../lib/ws'
import { api } from '../lib/client'
import { ROOM_DECISION_CREATED_EVENT, ROOM_ESCALATION_CREATED_EVENT } from '../lib/room-events'
import { isPermitted, show, clearBadge } from '../lib/notifications'
import type { Escalation, QuorumDecision } from '@shared/types'

/**
 * Global hook: subscribes to all room WebSocket channels and fires
 * browser notifications for escalations and new proposals.
 * Mount once in App.tsx after auth is ready.
 */
export function useNotifications(): void {
  const enabledRef = useRef(true)

  // Check if notifications are enabled
  useEffect(() => {
    api.settings.get('notifications_enabled').then((v) => {
      enabledRef.current = v !== 'false'
    }).catch(() => {})
  }, [])

  // Clear badge when user focuses the tab
  useEffect(() => {
    const onFocus = () => clearBadge()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    const unsubscribes: Array<() => void> = []

    async function setup(): Promise<void> {
      let rooms: Array<{ id: number }>
      try {
        rooms = await api.rooms.list()
      } catch {
        return
      }

      for (const room of rooms) {
        const channel = `room:${room.id}`
        const unsub = wsClient.subscribe(channel, (event: WsMessage) => {
          if (!enabledRef.current || !isPermitted() || document.hasFocus()) return

          if (event.type === ROOM_ESCALATION_CREATED_EVENT) {
            const esc = event.data as Escalation
            show('New Escalation', esc.question)
          } else if (event.type === ROOM_DECISION_CREATED_EVENT) {
            const dec = event.data as QuorumDecision
            show('New Proposal', dec.proposal)
          }
        })
        unsubscribes.push(unsub)
      }
    }

    setup()
    return () => { unsubscribes.forEach(fn => fn()) }
  }, [])
}
