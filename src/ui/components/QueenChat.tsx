import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/client'
import type { ChatMessage } from '@shared/types'

interface QueenChatProps {
  roomId: number | null
}

export function QueenChat({ roomId }: QueenChatProps): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!roomId) return
    setMessages([])
    setError(null)
    api.chat.messages(roomId).then(setMessages).catch(() => {})
  }, [roomId])

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  }, [])

  async function handleSend(): Promise<void> {
    if (!roomId || !input.trim() || loading) return
    const message = input.trim()
    setInput('')
    setError(null)
    setLoading(true)
    autoScrollRef.current = true

    const tempMsg: ChatMessage = {
      id: -Date.now(),
      roomId,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString()
    }
    setMessages(prev => [...prev, tempMsg])

    try {
      const result = await api.chat.send(roomId, message)
      setMessages(result.messages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function handleReset(): void {
    if (!roomId) return
    api.chat.reset(roomId).then(() => {
      setMessages([])
      setError(null)
    }).catch(() => {})
  }

  if (!roomId) {
    return (
      <div className="bg-surface-secondary rounded-lg flex-1 flex items-center justify-center min-h-0 shadow-sm">
        <span className="text-sm text-text-muted">Select a room to chat with the queen</span>
      </div>
    )
  }

  return (
    <div className="bg-surface-secondary rounded-lg overflow-hidden flex-1 flex flex-col min-h-0 shadow-sm">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-console-bg mx-3 mt-3 rounded-lg p-3 font-mono text-sm leading-relaxed min-h-[4rem]"
      >
        {messages.length === 0 && !loading ? (
          <div className="text-console-muted">Ask the queen anything...</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`mb-1.5 ${msg.role === 'user' ? '' : ''}`}>
              <span className={msg.role === 'user' ? 'text-blue-400' : 'text-green-300'}>
                {msg.role === 'user' ? '> ' : ''}
              </span>
              <span className={msg.role === 'user' ? 'text-blue-300' : 'text-green-200'}>
                {msg.content}
              </span>
            </div>
          ))
        )}
        {loading && (
          <div className="text-amber-400 animate-pulse">Thinking...</div>
        )}
        {error && (
          <div className="text-red-400">{error}</div>
        )}
      </div>

      <div className="flex items-center gap-2 mx-3 mb-3 mt-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          disabled={loading}
          placeholder="Ask the queen..."
          className="flex-1 px-3 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary text-text-primary disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="px-4 py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0 transition-colors"
        >
          Send
        </button>
        {messages.length > 0 && (
          <button
            onClick={handleReset}
            disabled={loading}
            className="px-3 py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary rounded-lg hover:border-interactive disabled:opacity-50 shrink-0 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
