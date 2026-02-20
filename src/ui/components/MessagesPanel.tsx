import { useState, useEffect, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import type { Escalation, Worker, RoomMessage } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-50 border-amber-200',
  in_progress: 'bg-blue-50 border-blue-200',
  resolved: 'bg-gray-100 border-transparent',
}

interface MessagesPanelProps {
  roomId: number | null
  autonomyMode: 'auto' | 'semi'
}

export function MessagesPanel({ roomId, autonomyMode }: MessagesPanelProps): React.JSX.Element {
  const semi = autonomyMode === 'semi'
  const [viewSection, setViewSection] = useState<'escalations' | 'rooms'>('escalations')
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('quoroom_messages_collapsed') === 'true')

  const { data: escalations, refresh } = usePolling<Escalation[]>(
    () => roomId ? api.escalations.list(roomId) : Promise.resolve([]),
    5000
  )
  const { data: roomMessages, refresh: refreshMessages } = usePolling<RoomMessage[]>(
    () => roomId ? api.roomMessages.list(roomId) : Promise.resolve([]),
    10000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 30000)

  // Real-time updates via WebSocket
  const wsEvent = useWebSocket(roomId ? `room:${roomId}` : '')
  useEffect(() => { if (wsEvent) { refresh(); refreshMessages() } }, [wsEvent, refresh, refreshMessages])

  useEffect(() => { refresh() }, [roomId, refresh])

  // State — always declared unconditionally (React hooks rule)
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [replyText, setReplyText] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [fromAgentId, setFromAgentId] = useState<number | ''>('')
  const [toAgentId, setToAgentId] = useState<number | ''>('')
  const [messageBody, setMessageBody] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [escalations?.length])

  const workerList = workers ?? []
  const workerMap = new Map(workerList.map(w => [w.id, w]))

  function getWorkerName(id: number | null): string {
    if (id === null) return 'System'
    return workerMap.get(id)?.name ?? `Worker #${id}`
  }

  async function handleReply(escalationId: number): Promise<void> {
    if (!replyText.trim()) return
    await api.escalations.resolve(escalationId, replyText.trim())
    setReplyText('')
    setReplyingTo(null)
    refresh()
  }

  async function handleCreateMessage(): Promise<void> {
    if (!roomId || fromAgentId === '' || !messageBody.trim()) return
    setCreateError(null)
    try {
      await api.escalations.create(
        roomId,
        fromAgentId,
        messageBody.trim(),
        toAgentId === '' ? undefined : toAgentId,
      )
      setMessageBody('')
      setFromAgentId('')
      setToAgentId('')
      setShowCreateForm(false)
      refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message'
      setCreateError(message)
    }
  }

  async function handleMarkAllRead(): Promise<void> {
    if (!roomId) return
    if (viewSection === 'escalations') {
      const pending = (escalations ?? []).filter(e => e.status === 'pending')
      await Promise.all(pending.map(e => api.escalations.resolve(e.id, '')))
      refresh()
    } else {
      const unread = (roomMessages ?? []).filter(m => m.status === 'unread')
      await Promise.all(unread.map(m => api.roomMessages.markRead(roomId, m.id)))
      refreshMessages()
    }
  }

  const pending = (escalations ?? []).filter(e => e.status === 'pending')
  const unreadMessages = (roomMessages ?? []).filter(m => m.status === 'unread')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center gap-2">
        <div className="flex gap-1 bg-gray-100 rounded p-0.5">
          <button
            onClick={() => setViewSection('escalations')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              viewSection === 'escalations' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            My Room{pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
          <button
            onClick={() => setViewSection('rooms')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              viewSection === 'rooms' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Outside Rooms{unreadMessages.length > 0 ? ` (${unreadMessages.length})` : ''}
          </button>
        </div>
        {((viewSection === 'escalations' && pending.length > 0) || (viewSection === 'rooms' && unreadMessages.length > 0)) && (
          <button
            onClick={handleMarkAllRead}
            className="text-[10px] text-gray-400 hover:text-gray-600"
          >
            Mark all read
          </button>
        )}
        <button
          onClick={() => setCollapsed(c => { const next = !c; localStorage.setItem('quoroom_messages_collapsed', String(next)); return next })}
          className="text-[10px] text-gray-400 hover:text-gray-600"
        >
          {collapsed ? 'Expand all' : 'Collapse all'}
        </button>
        {semi && roomId && viewSection === 'escalations' && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium ml-auto"
          >
            {showCreateForm ? 'Cancel' : '+ New'}
          </button>
        )}
      </div>

      {/* Create message form (semi-mode only) */}
      {semi && showCreateForm && roomId && (
        <div className="p-3 border-b-2 border-blue-300 bg-blue-50/50 space-y-2">
          <div className="flex gap-2">
            <select
              value={fromAgentId}
              onChange={(e) => { setFromAgentId(e.target.value === '' ? '' : Number(e.target.value)); setCreateError(null) }}
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
            >
              <option value="">Send as worker...</option>
              {workerList.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <select
              value={toAgentId}
              onChange={(e) => setToAgentId(e.target.value === '' ? '' : Number(e.target.value))}
              className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white"
            >
              <option value="">To worker (optional)</option>
              {workerList.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <textarea
            value={messageBody}
            onChange={(e) => { setMessageBody(e.target.value); setCreateError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); handleCreateMessage() } }}
            rows={3}
            placeholder="Message body..."
            className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:border-gray-500 bg-white resize-y"
            autoFocus
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-xs text-red-500 truncate">{createError}</span>}
            <div className="flex-1" />
            <button
              onClick={handleCreateMessage}
              disabled={fromAgentId === '' || !messageBody.trim()}
              className="text-xs bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-xs text-gray-400">Select a room to view messages.</div>
        ) : viewSection === 'escalations' ? (
          (escalations ?? []).length === 0 && escalations ? (
            <div className="p-4 text-xs text-gray-400">
              {semi ? 'No messages yet.' : 'No messages yet. Messages are created by agents.'}
            </div>
          ) : (
            <div className="p-3 space-y-3">
              {(escalations ?? []).map(esc => (
                <MessageBubble
                  key={esc.id}
                  escalation={esc}
                  collapsed={collapsed}
                  getWorkerName={getWorkerName}
                  isReplying={replyingTo === esc.id}
                  replyText={replyText}
                  onReplyToggle={() => {
                    setReplyingTo(replyingTo === esc.id ? null : esc.id)
                    setReplyText('')
                  }}
                  onReplyTextChange={setReplyText}
                  onReplySubmit={() => handleReply(esc.id)}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )
        ) : (
          /* Room Messages (inter-room) */
          (roomMessages ?? []).length === 0 ? (
            <div className="p-4 text-xs text-gray-400">
              No inter-room messages yet. Agents can send messages to other rooms.
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {(roomMessages ?? []).map(msg => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-2.5 border ${
                    msg.status === 'unread'
                      ? 'bg-blue-50 border-blue-200'
                      : msg.status === 'replied'
                      ? 'bg-gray-50 border-gray-200'
                      : 'bg-gray-100 border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      msg.direction === 'inbound'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-purple-100 text-purple-700'
                    }`}>
                      {msg.direction}
                    </span>
                    {msg.fromRoomId && (
                      <span className="text-[10px] text-gray-500">from {msg.fromRoomId}</span>
                    )}
                    {msg.toRoomId && (
                      <span className="text-[10px] text-gray-500">to {msg.toRoomId}</span>
                    )}
                    <span className={`px-1 rounded text-[10px] ${
                      msg.status === 'unread' ? 'bg-blue-100 text-blue-600' : 'text-gray-400'
                    }`}>
                      {msg.status}
                    </span>
                    <span className="text-[10px] text-gray-400 ml-auto">
                      {formatRelativeTime(msg.createdAt)}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-gray-700">{msg.subject}</div>
                  {!collapsed && <div className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{msg.body}</div>}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  escalation: Escalation
  collapsed: boolean
  getWorkerName: (id: number | null) => string
  isReplying: boolean
  replyText: string
  onReplyToggle: () => void
  onReplyTextChange: (text: string) => void
  onReplySubmit: () => void
}

function MessageBubble({
  escalation: esc,
  collapsed,
  getWorkerName,
  isReplying,
  replyText,
  onReplyToggle,
  onReplyTextChange,
  onReplySubmit,
}: MessageBubbleProps): React.JSX.Element {
  const isPending = esc.status === 'pending'

  return (
    <div className="space-y-1.5">
      {/* Question bubble */}
      <div className={`rounded-lg p-2.5 max-w-[85%] border ${STATUS_COLORS[esc.status] ?? 'bg-gray-100 border-transparent'}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] font-medium text-gray-700">
            {getWorkerName(esc.fromAgentId)}
          </span>
          {esc.toAgentId !== null && (
            <>
              <span className="text-[10px] text-gray-400">&rarr;</span>
              <span className="text-[10px] text-gray-500">
                {getWorkerName(esc.toAgentId)}
              </span>
            </>
          )}
          {isPending && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
              pending
            </span>
          )}
          <span className="text-[10px] text-gray-400 ml-auto">
            {formatRelativeTime(esc.createdAt)}
          </span>
        </div>
        {!collapsed && (
          <>
            <div className="text-xs text-gray-800 whitespace-pre-wrap">{esc.question}</div>
            {/* Reply action for pending */}
            {isPending && (
              <button
                onClick={onReplyToggle}
                className="mt-1.5 text-[10px] text-blue-500 hover:text-blue-700 font-medium"
              >
                {isReplying ? 'Cancel' : 'Reply'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Reply input */}
      {!collapsed && isPending && isReplying && (
        <div className="flex gap-1.5 ml-4">
          <input
            value={replyText}
            onChange={(e) => onReplyTextChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onReplySubmit() } }}
            placeholder="Type your reply..."
            className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-blue-400 bg-white"
            autoFocus
          />
          <button
            onClick={onReplySubmit}
            disabled={!replyText.trim()}
            className="text-xs bg-blue-500 text-white px-2.5 py-1 rounded hover:bg-blue-600 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}

      {/* Answer bubble */}
      {!collapsed && esc.answer && (
        <div className="ml-8 rounded-lg p-2.5 max-w-[80%] bg-blue-50 border border-blue-100">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] font-medium text-blue-700">
              {esc.toAgentId !== null ? getWorkerName(esc.toAgentId) : 'Reply'}
            </span>
            {esc.resolvedAt && (
              <span className="text-[10px] text-gray-400 ml-auto">
                {formatRelativeTime(esc.resolvedAt)}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-800 whitespace-pre-wrap">{esc.answer}</div>
        </div>
      )}
    </div>
  )
}
