import { useEffect, useRef, useState, useCallback } from 'react'
import { wsClient, type WsMessage } from '../lib/ws'
import {
  ROOM_DECISION_KEEPER_VOTE_EVENT,
  ROOM_DECISION_RESOLVED_EVENT,
  ROOM_DECISION_VOTE_CAST_EVENT,
  ROOM_ESCALATION_CREATED_EVENT,
  ROOM_GOAL_PROGRESS_EVENT,
  ROOM_GOAL_UPDATED_EVENT,
  ROOM_SELF_MOD_EDITED_EVENT,
  ROOM_SELF_MOD_REVERTED_EVENT,
  ROOM_SKILL_CREATED_EVENT,
  ROOM_WALLET_RECEIVED_EVENT,
  ROOM_WALLET_SENT_EVENT,
  RUN_COMPLETED_EVENT,
  RUN_CREATED_EVENT,
  RUN_FAILED_EVENT,
} from '../lib/room-events'
import type { Room, Worker } from '@shared/types'

// ─── Types ──────────────────────────────────────────────────

export type SwarmEventKind =
  | 'worker_thinking'
  | 'worker_acting'
  | 'worker_voting'
  | 'worker_rate_limited'
  | 'worker_blocked'
  | 'vote_cast'
  | 'decision_approved'
  | 'decision_rejected'
  | 'goal_progress'
  | 'goal_completed'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'money_received'
  | 'money_sent'
  | 'escalation'
  | 'skill_created'
  | 'self_mod'

export interface SwarmEvent {
  id: string
  kind: SwarmEventKind
  roomId: number
  label: string
  expiresAt: number
}

export interface SwarmRipple {
  id: string
  roomId: number
  color: string
  expiresAt: number
}

// ─── Constants ──────────────────────────────────────────────

const BUBBLE_TTL = 5000
const RIPPLE_TTL = 1200
const MAX_BUBBLES = 20
const CLEANUP_MS = 1000

let idCounter = 0
function uid(): string { return `se-${++idCounter}-${Date.now()}` }

// ─── Event kind → visual info ───────────────────────────────

const RIPPLE_COLORS: Partial<Record<SwarmEventKind, string>> = {
  worker_thinking: 'var(--status-info)',
  worker_acting: 'var(--status-success)',
  worker_voting: 'var(--interactive)',
  vote_cast: 'var(--interactive)',
  decision_approved: 'var(--status-success)',
  decision_rejected: 'var(--status-error)',
  goal_progress: 'var(--status-info)',
  goal_completed: 'var(--status-success)',
  task_started: 'var(--status-info)',
  task_completed: 'var(--status-success)',
  task_failed: 'var(--status-error)',
  money_received: 'var(--status-success)',
  money_sent: 'var(--status-error)',
  escalation: 'var(--status-warning)',
  skill_created: 'var(--interactive)',
  self_mod: 'var(--interactive)',
}

// ─── Worker state → event kind mapping ──────────────────────

function workerStateToKind(state: string): SwarmEventKind | null {
  switch (state) {
    case 'thinking': return 'worker_thinking'
    case 'acting': return 'worker_acting'
    case 'voting': return 'worker_voting'
    case 'rate_limited': return 'worker_rate_limited'
    case 'blocked': return 'worker_blocked'
    default: return null
  }
}

function workerStateLabel(state: string, workerName: string): string {
  const short = workerName.length > 10 ? workerName.slice(0, 9) + '\u2026' : workerName
  switch (state) {
    case 'thinking': return `${short} thinking`
    case 'acting': return `${short} acting`
    case 'voting': return `${short} voting`
    case 'rate_limited': return `${short} rate limited`
    case 'blocked': return `${short} blocked`
    default: return short
  }
}

// ─── WebSocket event → SwarmEvent mapping ───────────────────

function mapWsEvent(msg: WsMessage, rooms: Room[]): { kind: SwarmEventKind; label: string; roomId: number } | null {
  const data = msg.data as Record<string, unknown>

  // Extract roomId from channel pattern "room:123"
  let roomId = data.roomId as number | undefined
  if (!roomId && msg.channel.startsWith('room:')) {
    roomId = parseInt(msg.channel.split(':')[1], 10)
  }

  switch (msg.type) {
    case ROOM_DECISION_VOTE_CAST_EVENT: {
      const vote = (data.vote as string) ?? '?'
      return roomId ? { kind: 'vote_cast', label: `Vote: ${vote}`, roomId } : null
    }
    case ROOM_DECISION_RESOLVED_EVENT: {
      const status = data.status as string
      if (status === 'approved') return roomId ? { kind: 'decision_approved', label: 'Approved', roomId } : null
      if (status === 'rejected') return roomId ? { kind: 'decision_rejected', label: 'Rejected', roomId } : null
      if (status === 'vetoed') return roomId ? { kind: 'decision_rejected', label: 'Vetoed', roomId } : null
      return null
    }
    case ROOM_DECISION_KEEPER_VOTE_EVENT: {
      return roomId ? { kind: 'vote_cast', label: 'Keeper voted', roomId } : null
    }
    case ROOM_GOAL_PROGRESS_EVENT: {
      const val = data.metricValue as number | undefined
      const label = val != null ? `Goal ${Math.round(val * 100)}%` : 'Goal updated'
      return roomId ? { kind: 'goal_progress', label, roomId } : null
    }
    case ROOM_GOAL_UPDATED_EVENT: {
      const status = data.status as string | undefined
      if (status === 'completed') return roomId ? { kind: 'goal_completed', label: 'Goal completed', roomId } : null
      return null
    }
    case ROOM_ESCALATION_CREATED_EVENT: {
      return roomId ? { kind: 'escalation', label: 'Escalation', roomId } : null
    }
    case RUN_CREATED_EVENT: {
      // Runs channel doesn't have roomId — try to find the task's room
      // For now just use the first active room as fallback
      const targetRoom = rooms.find(r => r.status === 'active')?.id
      return targetRoom ? { kind: 'task_started', label: 'Task started', roomId: targetRoom } : null
    }
    case RUN_COMPLETED_EVENT: {
      const targetRoom = (roomId ?? rooms.find(r => r.status === 'active')?.id)
      return targetRoom ? { kind: 'task_completed', label: 'Task done', roomId: targetRoom } : null
    }
    case RUN_FAILED_EVENT: {
      const targetRoom = (roomId ?? rooms.find(r => r.status === 'active')?.id)
      return targetRoom ? { kind: 'task_failed', label: 'Task failed', roomId: targetRoom } : null
    }
    case ROOM_SKILL_CREATED_EVENT: {
      return roomId ? { kind: 'skill_created', label: 'Skill created', roomId } : null
    }
    case ROOM_WALLET_SENT_EVENT: {
      const amount = data.amount as number | undefined
      const label = amount ? `-$${amount}` : 'Sent'
      return roomId ? { kind: 'money_sent', label, roomId } : null
    }
    case ROOM_WALLET_RECEIVED_EVENT: {
      const amount = data.amount as number | undefined
      const label = amount ? `+$${amount}` : 'Received'
      return roomId ? { kind: 'money_received', label, roomId } : null
    }
    case ROOM_SELF_MOD_EDITED_EVENT: {
      const reason = (data.reason as string) ?? 'Code modified'
      const short = reason.length > 18 ? reason.slice(0, 17) + '\u2026' : reason
      return roomId ? { kind: 'self_mod', label: short, roomId } : null
    }
    case ROOM_SELF_MOD_REVERTED_EVENT: {
      return roomId ? { kind: 'self_mod', label: 'Mod reverted', roomId } : null
    }
    default:
      return null
  }
}

// ─── Hook ───────────────────────────────────────────────────

export function useSwarmEvents(
  rooms: Room[],
  allWorkers: Worker[] | null
): { events: SwarmEvent[]; ripples: SwarmRipple[] } {
  const [events, setEvents] = useState<SwarmEvent[]>([])
  const [ripples, setRipples] = useState<SwarmRipple[]>([])
  const prevWorkersRef = useRef<Worker[] | null>(null)
  const roomsRef = useRef(rooms)
  roomsRef.current = rooms

  // Add a new event + ripple
  const pushEvent = useCallback((kind: SwarmEventKind, label: string, roomId: number) => {
    const now = Date.now()
    const event: SwarmEvent = { id: uid(), kind, roomId, label, expiresAt: now + BUBBLE_TTL }
    const ripple: SwarmRipple = {
      id: uid(),
      roomId,
      color: RIPPLE_COLORS[kind] ?? 'var(--border-primary)',
      expiresAt: now + RIPPLE_TTL,
    }
    setEvents(prev => {
      const next = [...prev, event]
      return next.length > MAX_BUBBLES ? next.slice(next.length - MAX_BUBBLES) : next
    })
    setRipples(prev => [...prev, ripple])
  }, [])

  // ── Source A: Polling diffs for worker state changes ──
  useEffect(() => {
    if (!allWorkers) return
    const prev = prevWorkersRef.current
    if (prev) {
      for (const w of allWorkers) {
        if (!w.roomId) continue
        const old = prev.find(p => p.id === w.id)
        if (old && old.agentState !== w.agentState) {
          const kind = workerStateToKind(w.agentState)
          if (kind) {
            pushEvent(kind, workerStateLabel(w.agentState, w.name), w.roomId)
          }
        }
      }
    }
    prevWorkersRef.current = allWorkers
  }, [allWorkers, pushEvent])

  // ── Source B: WebSocket subscriptions ──
  useEffect(() => {
    const unsubs: Array<() => void> = []

    // Subscribe to each room channel
    for (const room of rooms) {
      unsubs.push(
        wsClient.subscribe(`room:${room.id}`, (msg: WsMessage) => {
          const mapped = mapWsEvent(msg, roomsRef.current)
          if (mapped) pushEvent(mapped.kind, mapped.label, mapped.roomId)
        })
      )
    }

    // Subscribe to runs channel
    unsubs.push(
      wsClient.subscribe('runs', (msg: WsMessage) => {
        const mapped = mapWsEvent(msg, roomsRef.current)
        if (mapped) pushEvent(mapped.kind, mapped.label, mapped.roomId)
      })
    )

    return () => { for (const unsub of unsubs) unsub() }
  }, [rooms, pushEvent])

  // ── Cleanup expired events/ripples ──
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setEvents(prev => {
        const next = prev.filter(e => e.expiresAt > now)
        return next.length === prev.length ? prev : next
      })
      setRipples(prev => {
        const next = prev.filter(r => r.expiresAt > now)
        return next.length === prev.length ? prev : next
      })
    }, CLEANUP_MS)
    return () => clearInterval(timer)
  }, [])

  // ── Demo mode: ?demo in URL fires simulated events ──
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('demo')) return
    if (rooms.length === 0) return

    const DEMO_EVENTS: Array<{ kind: SwarmEventKind; label: string }> = [
      { kind: 'worker_thinking', label: 'Ada thinking' },
      { kind: 'worker_acting', label: 'Ada acting' },
      { kind: 'worker_voting', label: 'Ada voting' },
      { kind: 'vote_cast', label: 'Vote: yes' },
      { kind: 'vote_cast', label: 'Vote: no' },
      { kind: 'decision_approved', label: 'Approved' },
      { kind: 'decision_rejected', label: 'Rejected' },
      { kind: 'goal_progress', label: 'Goal 42%' },
      { kind: 'goal_progress', label: 'Goal 78%' },
      { kind: 'goal_completed', label: 'Goal completed' },
      { kind: 'task_started', label: 'Task started' },
      { kind: 'task_completed', label: 'Task done' },
      { kind: 'task_failed', label: 'Task failed' },
      { kind: 'money_received', label: '+$150' },
      { kind: 'money_sent', label: '-$22.50' },
      { kind: 'money_received', label: '+$500' },
      { kind: 'escalation', label: 'Escalation' },
      { kind: 'skill_created', label: 'Skill created' },
      { kind: 'worker_thinking', label: 'John thinking' },
      { kind: 'worker_acting', label: 'John acting' },
      { kind: 'worker_rate_limited', label: 'Ada rate limited' },
      { kind: 'worker_blocked', label: 'John blocked' },
      { kind: 'money_sent', label: '-$7.50 srv' },
      { kind: 'task_started', label: 'HN Digest' },
      { kind: 'task_completed', label: 'HN Digest done' },
      { kind: 'vote_cast', label: 'Vote: abstain' },
      { kind: 'goal_progress', label: 'Goal 95%' },
      { kind: 'self_mod', label: 'Skill rewritten' },
      { kind: 'self_mod', label: 'Mod reverted' },
    ]
    let idx = 0
    const fire = () => {
      const roomIds = rooms.map(r => r.id)
      const roomId = roomIds[Math.floor(Math.random() * roomIds.length)]
      const demo = DEMO_EVENTS[idx % DEMO_EVENTS.length]
      pushEvent(demo.kind, demo.label, roomId)
      idx++
    }
    // Fire a burst of 3 immediately, then every 800-2000ms
    fire(); setTimeout(fire, 200); setTimeout(fire, 500)
    const timer = setInterval(() => {
      fire()
      // Occasionally fire 2 at once for overlapping effect
      if (Math.random() < 0.3) setTimeout(fire, 150)
    }, 800 + Math.random() * 1200)
    return () => clearInterval(timer)
  }, [rooms, pushEvent])

  return { events, ripples }
}
