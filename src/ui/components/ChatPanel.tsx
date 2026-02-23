import { useState, useEffect } from 'react'
import { QueenChat } from './QueenChat'
import { usePolling } from '../hooks/usePolling'
import { useTick } from '../hooks/useTick'
import { api } from '../lib/client'
import {
  ROOM_ESCALATION_EVENT_TYPES,
  ROOM_MESSAGE_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import type { Escalation, RoomMessage, Worker } from '@shared/types'

interface ChatPanelProps {
  roomId: number | null
}

export function ChatPanel({ roomId }: ChatPanelProps): React.JSX.Element {
  useTick()
  const [collapsed, setCollapsed] = useState(false)
  const [replyingTo, setReplyingTo] = useState<{ type: 'escalation' | 'message'; id: number } | null>(null)
  const [replyText, setReplyText] = useState('')

  const { data: escalations, refresh: refreshEscalations } = usePolling<Escalation[]>(
    () => roomId ? api.escalations.list(roomId, undefined, 'pending') : Promise.resolve([]),
    30000
  )
  const { data: roomMessages, refresh: refreshMessages } = usePolling<RoomMessage[]>(
    () => roomId ? api.roomMessages.list(roomId, 'unread') : Promise.resolve([]),
    30000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 60000)

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_ESCALATION_EVENT_TYPES.has(event.type)) void refreshEscalations()
      if (ROOM_MESSAGE_EVENT_TYPES.has(event.type)) void refreshMessages()
    })
  }, [roomId, refreshEscalations, refreshMessages])

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))
  function getWorkerName(id: number | null): string {
    if (id === null) return 'Keeper'
    return workerMap.get(id)?.name ?? `Worker #${id}`
  }

  const pendingEscalations = escalations ?? []
  const unreadMessages = roomMessages ?? []
  const totalUnread = pendingEscalations.length + unreadMessages.length

  async function handleResolve(id: number): Promise<void> {
    if (!replyText.trim()) return
    await api.escalations.resolve(id, replyText.trim())
    setReplyText('')
    setReplyingTo(null)
    refreshEscalations()
  }

  async function handleMarkRead(messageId: number): Promise<void> {
    if (!roomId) return
    await api.roomMessages.markRead(roomId, messageId)
    refreshMessages()
  }

  return (
    <div className="p-4 flex flex-col min-h-full">
      {totalUnread > 0 && (
        <div className="mb-3 bg-surface-secondary rounded-lg shadow-sm overflow-hidden">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover transition-colors"
          >
            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-status-error text-text-invert text-[10px] font-bold leading-none">
              {totalUnread}
            </span>
            <span>unread</span>
            <span className="ml-auto text-text-muted text-xs">{collapsed ? '\u25BE' : '\u25B4'}</span>
          </button>

          {!collapsed && (
            <div className="border-t border-border-primary px-3 py-2 space-y-1.5 max-h-48 overflow-y-auto">
              {pendingEscalations.map(esc => (
                <div key={`esc-${esc.id}`} className="border-l-2 border-amber-400 pl-2 py-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-text-secondary">{getWorkerName(esc.fromAgentId)}</span>
                    <span className="text-text-muted ml-auto">{formatRelativeTime(esc.createdAt)}</span>
                  </div>
                  <div className="text-sm text-text-primary truncate">{esc.question}</div>
                  {replyingTo?.type === 'escalation' && replyingTo.id === esc.id ? (
                    <div className="flex gap-1.5 mt-1">
                      <input
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleResolve(esc.id) } }}
                        placeholder="Reply..."
                        className="flex-1 px-2 py-1 text-xs border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary"
                        autoFocus
                      />
                      <button
                        onClick={() => handleResolve(esc.id)}
                        disabled={!replyText.trim()}
                        className="text-xs bg-interactive text-text-invert px-2 py-1 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
                      >
                        Send
                      </button>
                      <button
                        onClick={() => { setReplyingTo(null); setReplyText('') }}
                        className="text-xs text-text-muted px-1.5 py-1 rounded-lg hover:bg-surface-hover"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setReplyingTo({ type: 'escalation', id: esc.id }); setReplyText('') }}
                      className="mt-0.5 text-xs text-interactive hover:underline"
                    >
                      Reply
                    </button>
                  )}
                </div>
              ))}

              {unreadMessages.map(msg => (
                <div key={`msg-${msg.id}`} className="border-l-2 border-blue-400 pl-2 py-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-text-secondary">
                      {msg.fromRoomId ? `From ${msg.fromRoomId}` : 'Room message'}
                    </span>
                    <span className="text-text-muted ml-auto">{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <div className="text-sm text-text-primary truncate">{msg.subject}</div>
                  <button
                    onClick={() => handleMarkRead(msg.id)}
                    className="mt-0.5 text-xs text-interactive hover:underline"
                  >
                    Mark read
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <QueenChat roomId={roomId} />
    </div>
  )
}
