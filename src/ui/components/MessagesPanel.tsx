import { useState, useEffect, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/client'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { Escalation, Worker, RoomMessage } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-status-warning-bg border-amber-200',
  in_progress: 'bg-interactive-bg border-blue-200',
  resolved: 'bg-surface-tertiary border-transparent',
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
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2">
        <div className="flex gap-1 bg-surface-tertiary rounded-lg p-0.5">
          <button
            onClick={() => setViewSection('escalations')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewSection === 'escalations' ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            My Room{pending.length > 0 ? ` (${pending.length})` : ''}
          </button>
          <button
            onClick={() => setViewSection('rooms')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewSection === 'rooms' ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Outside Rooms{unreadMessages.length > 0 ? ` (${unreadMessages.length})` : ''}
          </button>
        </div>
        {((viewSection === 'escalations' && pending.length > 0) || (viewSection === 'rooms' && unreadMessages.length > 0)) && (
          <button
            onClick={handleMarkAllRead}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            Mark all read
          </button>
        )}
        <button
          onClick={() => setCollapsed(c => { const next = !c; localStorage.setItem('quoroom_messages_collapsed', String(next)); return next })}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          {collapsed ? 'Expand all' : 'Collapse all'}
        </button>
        {semi && roomId && viewSection === 'escalations' && (
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="text-sm text-interactive hover:text-interactive-hover font-medium ml-auto"
          >
            {showCreateForm ? 'Cancel' : '+ New'}
          </button>
        )}
      </div>

      {/* Create message form (semi-mode only) */}
      {semi && showCreateForm && roomId && (
        <div className="p-4 border-b-2 border-blue-300 bg-interactive-bg/50 space-y-2">
          <div className="flex gap-2">
            <Select
              value={String(fromAgentId)}
              onChange={(v) => { setFromAgentId(v === '' ? '' : Number(v)); setCreateError(null) }}
              className="flex-1"
              placeholder="Send as worker..."
              options={[
                { value: '', label: 'Send as worker...' },
                ...workerList.map(w => ({ value: String(w.id), label: w.name }))
              ]}
            />
            <Select
              value={String(toAgentId)}
              onChange={(v) => setToAgentId(v === '' ? '' : Number(v))}
              className="flex-1"
              placeholder="To worker (optional)"
              options={[
                { value: '', label: 'To worker (optional)' },
                ...workerList.map(w => ({ value: String(w.id), label: w.name }))
              ]}
            />
          </div>
          <textarea
            value={messageBody}
            onChange={(e) => { setMessageBody(e.target.value); setCreateError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); handleCreateMessage() } }}
            rows={3}
            placeholder="Message body..."
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-gray-500 bg-surface-primary resize-y"
            autoFocus
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-sm text-status-error truncate">{createError}</span>}
            <div className="flex-1" />
            <button
              onClick={handleCreateMessage}
              disabled={fromAgentId === '' || !messageBody.trim()}
              className="text-sm bg-interactive text-white px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">Select a room to view messages.</div>
        ) : viewSection === 'escalations' ? (
          (escalations ?? []).length === 0 && escalations ? (
            <div className="p-4 text-sm text-text-muted">
              {semi ? 'No messages yet.' : 'No messages yet. Messages are created by agents.'}
            </div>
          ) : (
            <div className="p-4 space-y-3">
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
            <div className="p-4 text-sm text-text-muted">
              No inter-room messages yet. Agents can send messages to other rooms.
            </div>
          ) : (
            <div className="p-4 space-y-2">
              {(roomMessages ?? []).map(msg => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-3 border shadow-sm ${
                    msg.status === 'unread'
                      ? 'bg-interactive-bg border-blue-200'
                      : msg.status === 'replied'
                      ? 'bg-surface-secondary border-border-primary'
                      : 'bg-surface-tertiary border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium ${
                      msg.direction === 'inbound'
                        ? 'bg-status-success-bg text-status-success'
                        : 'bg-status-info-bg text-status-info'
                    }`}>
                      {msg.direction}
                    </span>
                    {msg.fromRoomId && (
                      <span className="text-xs text-text-muted">from {msg.fromRoomId}</span>
                    )}
                    {msg.toRoomId && (
                      <span className="text-xs text-text-muted">to {msg.toRoomId}</span>
                    )}
                    <span className={`px-1 rounded-lg text-xs ${
                      msg.status === 'unread' ? 'bg-interactive-bg text-interactive' : 'text-text-muted'
                    }`}>
                      {msg.status}
                    </span>
                    <span className="text-xs text-text-muted ml-auto">
                      {formatRelativeTime(msg.createdAt)}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-text-secondary">{msg.subject}</div>
                  {!collapsed && <div className="text-sm text-text-secondary mt-0.5 whitespace-pre-wrap">{msg.body}</div>}
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
    <div className="space-y-2">
      {/* Question bubble */}
      <div className={`rounded-lg p-3 max-w-[85%] border shadow-sm ${STATUS_COLORS[esc.status] ?? 'bg-surface-tertiary border-transparent'}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {getWorkerName(esc.fromAgentId)}
          </span>
          {esc.toAgentId !== null && (
            <>
              <span className="text-xs text-text-muted">&rarr;</span>
              <span className="text-xs text-text-muted">
                {getWorkerName(esc.toAgentId)}
              </span>
            </>
          )}
          {isPending && (
            <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-warning-bg text-status-warning">
              pending
            </span>
          )}
          <span className="text-xs text-text-muted ml-auto">
            {formatRelativeTime(esc.createdAt)}
          </span>
        </div>
        {!collapsed && (
          <>
            <div className="text-sm text-text-primary whitespace-pre-wrap">{esc.question}</div>
            {/* Reply action for pending */}
            {isPending && (
              <button
                onClick={onReplyToggle}
                className="mt-1.5 text-xs text-interactive hover:text-interactive-hover font-medium"
              >
                {isReplying ? 'Cancel' : 'Reply'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Reply input */}
      {!collapsed && isPending && isReplying && (
        <div className="flex gap-2 ml-4">
          <input
            value={replyText}
            onChange={(e) => onReplyTextChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onReplySubmit() } }}
            placeholder="Type your reply..."
            className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-blue-400 bg-surface-primary"
            autoFocus
          />
          <button
            onClick={onReplySubmit}
            disabled={!replyText.trim()}
            className="text-sm bg-interactive text-white px-2.5 py-1.5 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}

      {/* Answer bubble */}
      {!collapsed && esc.answer && (
        <div className="ml-8 rounded-lg p-3 max-w-[80%] bg-interactive-bg border border-interactive-bg shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-interactive">
              {esc.toAgentId !== null ? getWorkerName(esc.toAgentId) : 'Reply'}
            </span>
            {esc.resolvedAt && (
              <span className="text-xs text-text-muted ml-auto">
                {formatRelativeTime(esc.resolvedAt)}
              </span>
            )}
          </div>
          <div className="text-sm text-text-primary whitespace-pre-wrap">{esc.answer}</div>
        </div>
      )}
    </div>
  )
}
