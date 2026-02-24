import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/client'
import { usePolling } from '../hooks/usePolling'
import { wsClient, type WsMessage } from '../lib/ws'
import { ClerkSetupGuide } from './ClerkSetupGuide'
import type { ClerkMessage } from '@shared/types'

interface ProviderStatusEntry {
  installed: boolean
  connected: boolean | null
}

/** Process inline markdown: **bold**, *italic*, `code`, [text](url) */
function processInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    if (match[1]) {
      // **bold**
      parts.push(<strong key={match.index} className="font-semibold text-text-primary">{match[2]}</strong>)
    } else if (match[3]) {
      // *italic*
      parts.push(<em key={match.index}>{match[4]}</em>)
    } else if (match[5]) {
      // `code`
      parts.push(
        <code key={match.index} className="px-1 py-0.5 rounded bg-surface-tertiary text-text-secondary text-[0.85em] font-mono">
          {match[6]}
        </code>
      )
    } else if (match[7]) {
      // [text](url)
      parts.push(
        <a
          key={match.index}
          href={match[9]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-interactive underline hover:text-interactive-hover"
        >
          {match[8]}
        </a>
      )
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

/** Render markdown content like VS Code Claude Code chat */
function renderMarkdown(text: string): React.JSX.Element {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Empty line = paragraph break
    if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />)
      i++
      continue
    }

    // ## Header
    const h2Match = line.match(/^##\s+(.+)/)
    if (h2Match) {
      elements.push(
        <h3 key={i} className="text-base font-semibold text-text-primary mt-3 mb-1.5">
          {processInline(h2Match[1])}
        </h3>
      )
      i++
      continue
    }

    // # Header
    const h1Match = line.match(/^#\s+(.+)/)
    if (h1Match) {
      elements.push(
        <h2 key={i} className="text-lg font-semibold text-text-primary mt-3 mb-1.5">
          {processInline(h1Match[1])}
        </h2>
      )
      i++
      continue
    }

    // Numbered list: 1. item
    const numMatch = line.match(/^(\d+)\.\s+(.+)/)
    if (numMatch) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\d+)\.\s+(.+)/)
        if (!m) break
        items.push(
          <li key={i} className="mb-0.5 pl-1">
            {processInline(m[2])}
          </li>
        )
        i++
      }
      elements.push(
        <ol key={`ol-${i}`} className="list-decimal list-inside my-1.5 space-y-0.5 text-text-secondary">
          {items}
        </ol>
      )
      continue
    }

    // Bullet list: - item or * item
    if (/^[-*]\s/.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(
          <li key={i} className="mb-0.5 pl-1">
            {processInline(lines[i].slice(2))}
          </li>
        )
        i++
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc list-inside my-1.5 space-y-0.5 text-text-secondary">
          {items}
        </ul>
      )
      continue
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="my-1 text-text-secondary leading-relaxed">
        {processInline(line)}
      </p>
    )
    i++
  }

  return <>{elements}</>
}

export function ClerkPanel(): React.JSX.Element {
  const [messages, setMessages] = useState<ClerkMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [clerkModel, setClerkModel] = useState<string | null>(null)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch clerk status
  const { data: clerkStatus, refresh: refreshStatus } = usePolling(
    () => api.clerk.status().catch(() => null),
    30000
  )

  // Fetch provider status for setup guide
  const { data: providerStatus } = usePolling<{
    codex: ProviderStatusEntry
    claude: ProviderStatusEntry
  } | null>(
    () => api.providers.status().catch(() => null),
    120000
  )

  // Load messages on mount
  useEffect(() => {
    api.clerk.messages().then((msgs) => {
      setMessages(msgs)
      setInitialLoaded(true)
      // Scroll to bottom after initial load
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }).catch(() => {
      setInitialLoaded(true)
    })
  }, [])

  // Show setup if no model configured
  useEffect(() => {
    if (clerkStatus) {
      setClerkModel(clerkStatus.model)
      if (!clerkStatus.model && !clerkStatus.configured && initialLoaded) {
        setShowSetup(true)
      }
    }
  }, [clerkStatus, initialLoaded])

  // Auto-scroll
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

  // Subscribe to commentary via WebSocket
  useEffect(() => {
    return wsClient.subscribe('clerk', (event: WsMessage) => {
      if (event.type === 'clerk:commentary') {
        const data = event.data as { content: string; source?: string }
        setMessages(prev => [...prev, {
          id: Date.now(),
          role: 'commentary' as const,
          content: data.content,
          source: data.source ?? null,
          createdAt: new Date().toISOString()
        }])
      }
    })
  }, [])

  async function handleSend(): Promise<void> {
    if (!input.trim() || loading) return
    const message = input.trim()
    setInput('')
    setError(null)
    setLoading(true)
    autoScrollRef.current = true

    const tempMsg: ClerkMessage = {
      id: -Date.now(),
      role: 'user',
      content: message,
      source: null,
      createdAt: new Date().toISOString()
    }
    setMessages(prev => [...prev, tempMsg])

    try {
      const result = await api.clerk.send(message)
      setMessages(result.messages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function handleReset(): void {
    api.clerk.reset().then(() => {
      setMessages([])
      setError(null)
    }).catch(() => {})
  }

  async function handleApplyModel(model: string): Promise<void> {
    await api.clerk.updateSettings({ model })
    setClerkModel(model)
    refreshStatus()
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-primary bg-surface-primary shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">Clerk</span>
          {clerkModel && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-tertiary text-text-muted">
              {clerkModel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSetup(true)}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Setup
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0"
      >
        <div className="max-w-[680px] mx-auto px-5 py-4">
        {messages.length === 0 && !loading ? (
          <div className="text-text-muted text-sm py-8 text-center">
            {clerkModel
              ? 'Your Clerk is ready. Ask anything or wait for commentary...'
              : 'Connect a model to start using your Clerk.'}
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="mb-5">
              {msg.role === 'user' ? (
                <div className="text-[13px] text-text-primary leading-relaxed font-medium">
                  {msg.content}
                </div>
              ) : msg.role === 'assistant' ? (
                <div className="text-[13px] leading-[1.7] text-text-secondary">
                  {renderMarkdown(msg.content)}
                </div>
              ) : (
                /* Commentary */
                <div className="text-[13px] leading-[1.7] text-text-secondary border-l-2 border-border-primary pl-3">
                  {renderMarkdown(msg.content)}
                </div>
              )}
            </div>
          ))
        )}
        {loading && (
          <div className="text-[13px] text-text-muted animate-pulse mb-4">Thinking...</div>
        )}
        {error && (
          <div className="text-[13px] text-status-error mb-4">{error}</div>
        )}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border-primary bg-surface-primary px-4 py-3 flex justify-center">
      <div className="flex items-center gap-2 w-full max-w-[680px]">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          disabled={loading || !clerkModel}
          placeholder={clerkModel ? 'Ask your clerk anything...' : 'Connect a model first...'}
          className="flex-1 px-3 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-secondary text-text-primary disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim() || !clerkModel}
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

      {/* Setup guide modal */}
      {showSetup && (
        <ClerkSetupGuide
          claude={providerStatus?.claude ?? null}
          codex={providerStatus?.codex ?? null}
          queenAuth={null}
          onApplyModel={handleApplyModel}
          onClose={() => setShowSetup(false)}
        />
      )}
    </div>
  )
}
