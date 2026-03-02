import { useState, useEffect, useRef } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import {
  ROOM_ESCALATION_EVENT_TYPES,
  ROOM_MESSAGE_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { storageGet, storageSet } from '../lib/storage'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import { AutoModeLockModal, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { Escalation, EscalationStatus, Worker, RoomMessage } from '@shared/types'

const STATUS_COLORS: Record<EscalationStatus, string> = {
  pending: 'bg-surface-secondary border-border-primary',
  in_progress: 'bg-interactive-bg border-border-primary',
  resolved: 'bg-surface-tertiary border-border-primary',
}

interface MessagesPanelProps {
  roomId: number | null
  autonomyMode: 'semi'
}

export function MessagesPanel({ roomId, autonomyMode }: MessagesPanelProps): React.JSX.Element {
  const { semi, guard, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)
  const [viewSection, setViewSection] = useState<'escalations' | 'rooms'>('escalations')
  const [scope, setScope] = useState<'keeper' | 'all'>(() => {
    const saved = storageGet('quoroom_messages_scope')
    return saved === 'all' ? 'all' : 'keeper'
  })
  const [collapsed, setCollapsed] = useState(() => storageGet('quoroom_messages_collapsed') === 'true')

  const { data: escalations, refresh } = usePolling<Escalation[]>(
    () => roomId ? api.escalations.list(roomId) : Promise.resolve([]),
    30000
  )
  const { data: roomMessages, refresh: refreshMessages } = usePolling<RoomMessage[]>(
    () => roomId ? api.roomMessages.list(roomId) : Promise.resolve([]),
    30000
  )
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list(), 60000)

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_ESCALATION_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
      if (ROOM_MESSAGE_EVENT_TYPES.has(event.type)) {
        void refreshMessages()
      }
    })
  }, [refresh, refreshMessages, roomId])

  useEffect(() => {
    void refresh()
    void refreshMessages()
  }, [refresh, refreshMessages, roomId])

  // State — always declared unconditionally (React hooks rule)
  const [replyingTo, setReplyingTo] = useState<number | null>(null)
  const [replyText, setReplyText] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [toAgentId, setToAgentId] = useState<number | '' | 'developer'>('')
  const [messageBody, setMessageBody] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [replyingToMsg, setReplyingToMsg] = useState<number | null>(null)
  const [roomMsgReplyText, setRoomMsgReplyText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [escalations?.length, scope])

  const workerList = workers ?? []
  const workerMap = new Map(workerList.map(w => [w.id, w]))

  function getWorkerName(id: number | null): string {
    if (id === null) return 'Keeper'
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
    if (!roomId || !messageBody.trim()) return
    setCreateError(null)
    try {
      if (toAgentId === 'developer') {
        await api.roomMessages.create(roomId, 'developer', messageBody.trim(), 'Message to Developer')
        refreshMessages()
      } else {
        await api.escalations.create(
          roomId,
          null,
          messageBody.trim(),
          toAgentId === '' ? undefined : toAgentId,
        )
        refresh()
      }
      setMessageBody('')
      setToAgentId('')
      setShowCreateForm(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message'
      setCreateError(message)
    }
  }

  async function handleRoomMsgReply(messageId: number): Promise<void> {
    if (!roomMsgReplyText.trim()) return
    await api.roomMessages.reply(messageId, roomMsgReplyText.trim())
    setRoomMsgReplyText('')
    setReplyingToMsg(null)
    refreshMessages()
  }

  async function handleMarkAllRead(): Promise<void> {
    if (!roomId) return
    if (viewSection === 'escalations') {
      await Promise.all(pendingEscalations.map(e => api.escalations.resolve(e.id, '')))
      refresh()
    } else {
      const unread = (roomMessages ?? []).filter(m => m.status === 'unread')
      await Promise.all(unread.map(m => api.roomMessages.markRead(roomId, m.id)))
      refreshMessages()
    }
  }

  const filteredEscalations = (escalations ?? []).filter(e => (
    scope === 'all' || e.toAgentId === null || e.fromAgentId === null
  ))
  const pendingEscalations = filteredEscalations.filter(e => e.status === 'pending')
  const unreadMessages = (roomMessages ?? []).filter(m => m.status === 'unread')

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary mr-1">Messages</h2>
        <div className="flex gap-1 bg-interactive-bg rounded-lg p-0.5">
          <button
            onClick={() => setViewSection('escalations')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewSection === 'escalations'
                ? 'bg-interactive text-text-invert shadow-sm'
                : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
            }`}
          >
            My Room{pendingEscalations.length > 0 ? ` (${pendingEscalations.length})` : ''}
          </button>
          <button
            onClick={() => setViewSection('rooms')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              viewSection === 'rooms'
                ? 'bg-interactive text-text-invert shadow-sm'
                : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
            }`}
          >
            Outside Rooms{unreadMessages.length > 0 ? ` (${unreadMessages.length})` : ''}
          </button>
        </div>
        {viewSection === 'escalations' && (
          <button
            onClick={() => setScope((current) => {
              const next = current === 'keeper' ? 'all' : 'keeper'
              storageSet('quoroom_messages_scope', next)
              return next
            })}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:text-text-primary hover:border-interactive transition-colors"
          >
            {scope === 'keeper' ? 'Show internal' : 'Hide internal'}
          </button>
        )}
        {((viewSection === 'escalations' && pendingEscalations.length > 0) || (viewSection === 'rooms' && unreadMessages.length > 0)) && (
          <button
            onClick={handleMarkAllRead}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
          >
            Mark all read
          </button>
        )}
        <button
          onClick={() => setCollapsed(c => { const next = !c; storageSet('quoroom_messages_collapsed', String(next)); return next })}
          className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
        >
          {collapsed ? 'Expand all' : 'Collapse all'}
        </button>
        {roomId && viewSection === 'escalations' && (
          <button
            onClick={() => guard(() => setShowCreateForm(!showCreateForm))}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
          >
            {showCreateForm ? 'Cancel' : '+ New'}
          </button>
        )}
      </div>

      {/* Create message form (semi-mode only) */}
      {semi && showCreateForm && roomId && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <Select
            value={String(toAgentId)}
            onChange={(v) => setToAgentId(v === '' ? '' : v === 'developer' ? 'developer' : Number(v))}
            className="max-w-xs"
            placeholder="To worker (optional)"
            options={[
              { value: '', label: 'To worker (optional)' },
              { value: 'developer', label: 'Developer' },
              ...workerList.map(w => ({ value: String(w.id), label: w.name }))
            ]}
          />
          <textarea
            value={messageBody}
            onChange={(e) => { setMessageBody(e.target.value); setCreateError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); handleCreateMessage() } }}
            rows={3}
            placeholder="Message body..."
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary resize-y"
            autoFocus
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-sm text-status-error truncate">{createError}</span>}
            <div className="flex-1" />
            <button
              onClick={handleCreateMessage}
              disabled={!messageBody.trim()}
              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
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
          filteredEscalations.length === 0 && escalations ? (
            <div className="p-4 text-sm text-text-muted">
              {semi ? 'No messages yet.' : 'No messages yet. Messages are created by agents.'}
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {filteredEscalations.map(esc => (
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
                      ? 'bg-interactive-bg border-interactive'
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
                  {/* Reply button for inbound messages that haven't been replied to */}
                  {!collapsed && msg.direction === 'inbound' && msg.status !== 'replied' && (
                    <button
                      onClick={() => { setReplyingToMsg(replyingToMsg === msg.id ? null : msg.id); setRoomMsgReplyText('') }}
                      className="mt-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover font-medium"
                    >
                      {replyingToMsg === msg.id ? 'Cancel' : 'Reply'}
                    </button>
                  )}
                  {/* Reply input */}
                  {!collapsed && replyingToMsg === msg.id && (
                    <div className="flex gap-2 mt-2">
                      <input
                        value={roomMsgReplyText}
                        onChange={(e) => setRoomMsgReplyText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRoomMsgReply(msg.id) } }}
                        placeholder="Type your reply..."
                        className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary"
                        autoFocus
                      />
                      <button
                        onClick={() => handleRoomMsgReply(msg.id)}
                        disabled={!roomMsgReplyText.trim()}
                        className="text-sm bg-interactive text-text-invert px-2.5 py-1.5 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
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
      <div className={`rounded-lg p-3 max-w-[85%] border shadow-sm ${STATUS_COLORS[esc.status] ?? 'bg-surface-tertiary border-border-primary'}`}>
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
              Needs reply
            </span>
          )}
          <span className="text-xs text-text-muted ml-auto">
            {formatRelativeTime(esc.createdAt)}
          </span>
        </div>
        {collapsed && (
          <div className="text-sm text-text-secondary truncate">
            {esc.question}
          </div>
        )}
        {!collapsed && (
          <>
            <div className="text-sm text-text-primary whitespace-pre-wrap">{esc.question}</div>
            {/* Reply action for pending */}
            {isPending && (
              <button
                onClick={onReplyToggle}
                className="mt-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover font-medium"
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
            className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary"
            autoFocus
          />
          <button
            onClick={onReplySubmit}
            disabled={!replyText.trim()}
            className="text-sm bg-interactive text-text-invert px-2.5 py-1.5 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
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
