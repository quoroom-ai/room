import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/client'
import { usePolling } from '../hooks/usePolling'
import { useDocumentVisible } from '../hooks/useDocumentVisible'
import { wsClient, type WsMessage } from '../lib/ws'
import { ClerkSetupGuide } from './ClerkSetupGuide'
import type { ClerkMessage } from '@shared/types'

interface ProviderStatusEntry {
  installed: boolean
  connected: boolean | null
}

interface ClerkPanelProps {
  setupLaunchKey?: number
}

const HIGH_SPEED_TYPING_STEP_MS = 12
const HIGH_SPEED_TYPING_CHARS_PER_TICK = 4

function channelTag(source: ClerkMessage['source']): string | null {
  if (!source) return null
  if (source === 'email') return 'email'
  if (source === 'telegram') return 'telegram'
  return null
}

function senderLabel(role: ClerkMessage['role']): string {
  if (role === 'user') return 'keeper'
  if (role === 'assistant') return 'clerk'
  return 'commentary'
}

function senderTagClass(role: ClerkMessage['role']): string {
  if (role === 'user') return 'bg-surface-primary text-text-primary border-text-muted'
  if (role === 'assistant') return 'bg-surface-tertiary text-text-secondary border-border-primary'
  return 'bg-surface-secondary text-text-muted border-border-primary'
}

function dedupeById(items: ClerkMessage[]): ClerkMessage[] {
  const seen = new Set<number>()
  const out: ClerkMessage[] = []
  for (const item of items) {
    if (item.id > 0) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
    }
    out.push(item)
  }
  return out
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
  const bulletRegex = /^[-*•]\s+(.+)/

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
        <h3 key={i} className="text-[19px] font-semibold text-text-primary mt-3 mb-1.5">
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
        <h2 key={i} className="text-[22px] font-semibold text-text-primary mt-3 mb-1.5">
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
          <li key={i} className="leading-relaxed">
            {processInline(m[2])}
          </li>
        )
        i++
      }
      elements.push(
        <ol key={`ol-${i}`} className="list-decimal list-outside pl-6 my-2.5 space-y-1.5 text-text-secondary marker:text-text-muted">
          {items}
        </ol>
      )
      continue
    }

    // Bullet list: - item, * item, or • item
    if (bulletRegex.test(line)) {
      const items: React.ReactNode[] = []
      while (i < lines.length) {
        const m = lines[i].match(bulletRegex)
        if (!m) break
        items.push(
          <li key={i} className="leading-relaxed">
            {processInline(m[1])}
          </li>
        )
        i++
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc list-outside pl-6 my-2.5 space-y-1.5 text-text-secondary marker:text-text-muted">
          {items}
        </ul>
      )
      continue
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="my-2 text-text-secondary leading-relaxed">
        {processInline(line)}
      </p>
    )
    i++
  }

  return <>{elements}</>
}

function AnimatedMarkdownMessage({
  id,
  content,
  shouldAnimate,
  onDone,
}: {
  id: number
  content: string
  shouldAnimate: boolean
  onDone: (id: number) => void
}): React.JSX.Element {
  const [visibleText, setVisibleText] = useState(shouldAnimate ? '' : content)

  useEffect(() => {
    if (!shouldAnimate) {
      setVisibleText(content)
      return
    }

    let idx = 0
    setVisibleText('')
    const timer = window.setInterval(() => {
      idx = Math.min(content.length, idx + HIGH_SPEED_TYPING_CHARS_PER_TICK)
      setVisibleText(content.slice(0, idx))
      if (idx >= content.length) {
        window.clearInterval(timer)
        onDone(id)
      }
    }, HIGH_SPEED_TYPING_STEP_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [content, id, onDone, shouldAnimate])

  return (
    <>
      {renderMarkdown(visibleText)}
      {shouldAnimate && visibleText.length < content.length && (
        <span className="inline-block w-1.5 h-4 ml-1 align-middle rounded-sm bg-text-muted animate-pulse" />
      )}
    </>
  )
}

function getModelConnectionStatus(
  model: string | null,
  providerStatus: { codex: ProviderStatusEntry; claude: ProviderStatusEntry } | null,
  apiAuth: { openai: { ready: boolean }; anthropic: { ready: boolean } } | null,
): { connected: boolean | null; label: string } {
  if (!model) return { connected: null, label: '' }

  if (model === 'claude') {
    if (!providerStatus) return { connected: null, label: 'checking' }
    return providerStatus.claude.connected === true
      ? { connected: true, label: 'connected' }
      : { connected: false, label: 'not connected' }
  }
  if (model === 'codex') {
    if (!providerStatus) return { connected: null, label: 'checking' }
    return providerStatus.codex.connected === true
      ? { connected: true, label: 'connected' }
      : { connected: false, label: 'not connected' }
  }
  if (model.startsWith('openai:')) {
    if (!apiAuth) return { connected: null, label: 'checking' }
    return apiAuth.openai.ready
      ? { connected: true, label: 'connected' }
      : { connected: false, label: 'not connected' }
  }
  if (model.startsWith('anthropic:')) {
    if (!apiAuth) return { connected: null, label: 'checking' }
    return apiAuth.anthropic.ready
      ? { connected: true, label: 'connected' }
      : { connected: false, label: 'not connected' }
  }

  return { connected: null, label: '' }
}

export function ClerkPanel({ setupLaunchKey = 0 }: ClerkPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<ClerkMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [clerkModel, setClerkModel] = useState<string | null>(null)
  const [commentaryEnabled, setCommentaryEnabled] = useState(true)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadingRef = useRef(false)
  const seenMessageIdsRef = useRef<Set<number>>(new Set())
  const completedTypingIdsRef = useRef<Set<number>>(new Set())
  const [typingMessageIds, setTypingMessageIds] = useState<Set<number>>(new Set())

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
      seenMessageIdsRef.current = new Set(msgs.map((m) => m.id))
      setMessages(dedupeById(msgs))
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
      setCommentaryEnabled(clerkStatus.commentaryEnabled ?? true)
      if (!clerkStatus.model && !clerkStatus.configured && initialLoaded) {
        setShowSetup(true)
      }
    }
  }, [clerkStatus, initialLoaded])

  useEffect(() => {
    if (setupLaunchKey <= 0) return
    setShowSetup(true)
  }, [setupLaunchKey])

  // Auto-scroll
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  // Presence heartbeat — keeps commentary in active mode while the page is open
  const isVisible = useDocumentVisible()
  useEffect(() => {
    if (!isVisible) return
    void api.clerk.presence().catch(() => {})
    const timer = window.setInterval(() => {
      void api.clerk.presence().catch(() => {})
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [isVisible])

  const typingActive = input.trim().length > 0 && !loading
  useEffect(() => {
    if (!typingActive) return

    const pingTyping = () => {
      void api.clerk.typing().catch(() => {})
    }

    // Pause commentary as soon as keeper starts typing.
    pingTyping()
    const timer = window.setInterval(pingTyping, 10_000)

    return () => {
      window.clearInterval(timer)
    }
  }, [typingActive])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
  }, [])

  useEffect(() => {
    if (!initialLoaded) return
    const seenIds = seenMessageIdsRef.current
    const newTypingIds: number[] = []

    for (const msg of messages) {
      if (seenIds.has(msg.id)) continue
      seenIds.add(msg.id)
      if (
        msg.id > 0
        && msg.role !== 'user'
        && !completedTypingIdsRef.current.has(msg.id)
      ) {
        newTypingIds.push(msg.id)
      }
    }

    if (newTypingIds.length > 0) {
      setTypingMessageIds((prev) => {
        const next = new Set(prev)
        for (const id of newTypingIds) next.add(id)
        return next
      })
    }
  }, [initialLoaded, messages])

  // Subscribe to commentary via WebSocket
  useEffect(() => {
    return wsClient.subscribe('clerk', (event: WsMessage) => {
      if (event.type === 'clerk:commentary') {
        if (loadingRef.current) return
        const data = event.data as { content: string; source?: string }
        setMessages(prev => [...prev, {
          id: Date.now(),
          role: 'commentary' as const,
          content: data.content,
          source: data.source ?? null,
          createdAt: new Date().toISOString()
        }])
        return
      }

      if (event.type === 'clerk:message') {
        const data = event.data as { message?: ClerkMessage }
        const message = data.message
        if (!message || typeof message.id !== 'number') return
        setMessages((prev) => {
          if (prev.some((item) => item.id === message.id)) return prev

          // Reconcile optimistic keeper message (negative id) with server-acked user message.
          if (message.role === 'user') {
            const optimisticIdx = prev.findIndex(
              (item) => item.id < 0 && item.role === 'user' && item.content === message.content
            )
            if (optimisticIdx >= 0) {
              const next = [...prev]
              next[optimisticIdx] = message
              return dedupeById(next)
            }
          }

          return dedupeById([...prev, message])
        })
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
      setMessages(dedupeById(result.messages))
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
      setTypingMessageIds(new Set())
      setError(null)
    }).catch(() => {})
  }

  const handleTypingDone = useCallback((id: number) => {
    completedTypingIdsRef.current.add(id)
    setTypingMessageIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  async function handleToggleCommentary(): Promise<void> {
    const next = !commentaryEnabled
    setCommentaryEnabled(next)
    await api.clerk.updateSettings({ commentaryEnabled: next })
  }

  async function handleApplyModel(model: string): Promise<void> {
    await api.clerk.updateSettings({ model })
    setClerkModel(model)
    refreshStatus()
  }

  async function handleSaveApiKey(provider: 'openai_api' | 'anthropic_api', key: string): Promise<void> {
    await api.clerk.setApiKey(provider, key)
    refreshStatus()
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border-primary bg-surface-primary shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[17px] font-semibold text-text-primary">Clerk</span>
          {clerkModel && (
            <span className="text-[14px] px-2 py-0.5 rounded bg-surface-tertiary text-text-muted">
              {clerkModel}
            </span>
          )}
          {(() => {
            const status = getModelConnectionStatus(clerkModel, providerStatus ?? null, clerkStatus?.apiAuth ?? null)
            if (!status.label) return null
            const dotColor = status.connected === true
              ? 'bg-status-success'
              : status.connected === false
                ? 'bg-status-error'
                : 'bg-text-muted animate-pulse'
            const textColor = status.connected === true
              ? 'text-status-success'
              : status.connected === false
                ? 'text-status-error'
                : 'text-text-muted'
            return (
              <span className={`flex items-center gap-1 text-[14px] ${textColor}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
                {status.label}
              </span>
            )
          })()}
          <button
            onClick={() => setShowSetup(true)}
            className="text-[14px] text-text-muted hover:text-text-secondary transition-colors"
          >
            Setup
          </button>
          <button
            onClick={handleToggleCommentary}
            title={commentaryEnabled ? 'Disable commentary' : 'Enable commentary'}
            className="flex items-center gap-1.5 text-[14px] text-text-muted hover:text-text-secondary transition-colors"
          >
            <span className={`inline-block w-7 h-4 rounded-full relative transition-colors ${commentaryEnabled ? 'bg-text-muted' : 'bg-surface-tertiary border border-border-primary'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${commentaryEnabled ? 'left-3.5' : 'left-0.5'}`} />
            </span>
            Commentary
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0"
      >
        <div className="max-w-[880px] mx-auto px-5 py-5">
        {messages.length === 0 && !loading ? (
          <div className="text-text-muted text-[16px] py-8 text-center">
            {clerkModel
              ? 'Your Clerk is ready. Ask anything or wait for commentary...'
              : 'Connect a model to start using your Clerk.'}
          </div>
        ) : (
          messages.map((msg) => {
            const sourceTag = channelTag(msg.source)
            const sender = senderLabel(msg.role)
            const showSenderBadge = msg.role !== 'commentary'
            const showHeader = showSenderBadge || Boolean(sourceTag)
            return (
              <div key={msg.id} className="mb-7">
                {showHeader && (
                  <div className={`flex items-center gap-2 ${msg.role === 'user' ? 'justify-end mb-0.5 pr-1' : 'mb-1.5'}`}>
                    {showSenderBadge && (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] uppercase tracking-wide ${senderTagClass(msg.role)}`}>
                        {sender}
                      </span>
                    )}
                    {sourceTag && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-border-primary text-[11px] uppercase tracking-wide text-text-muted bg-surface-tertiary">
                        {sourceTag}
                      </span>
                    )}
                  </div>
                )}
                {msg.role === 'user' ? (
                  <div className="max-w-[82%] ml-auto px-4 py-3 rounded-2xl border border-border-primary bg-surface-secondary">
                    <div className="text-[16px] text-text-primary leading-relaxed font-medium">
                      {msg.content}
                    </div>
                  </div>
                ) : msg.role === 'assistant' ? (
                  <div className="max-w-[88%] px-4 py-3 rounded-2xl border border-border-primary bg-surface-secondary">
                    <div className="text-[16px] leading-[1.7] text-text-secondary">
                      <AnimatedMarkdownMessage
                        id={msg.id}
                        content={msg.content}
                        shouldAnimate={typingMessageIds.has(msg.id)}
                        onDone={handleTypingDone}
                      />
                    </div>
                  </div>
                ) : (
                  /* Commentary */
                  <div className="max-w-[90%] px-4 py-3 rounded-xl border-l-2 border-border-primary bg-surface-primary">
                    <div className="text-[16px] leading-[1.7] text-text-secondary">
                      <AnimatedMarkdownMessage
                        id={msg.id}
                        content={msg.content}
                        shouldAnimate={typingMessageIds.has(msg.id)}
                        onDone={handleTypingDone}
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
        {loading && (
          <div className="text-[16px] text-text-muted animate-pulse mb-4">Thinking...</div>
        )}
        {error && (
          <div className="text-[16px] text-status-error mb-4">{error}</div>
        )}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border-primary bg-surface-primary px-4 py-3 flex justify-center">
      <div className="flex items-center gap-2 w-full max-w-[920px]">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          disabled={loading || !clerkModel}
          placeholder={clerkModel ? 'Ask your clerk anything...' : 'Connect a model first...'}
          className="flex-1 px-4 py-3 text-[16px] border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-secondary text-text-primary disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim() || !clerkModel}
          className="px-5 py-3 text-[16px] bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0 transition-colors"
        >
          Send
        </button>
        {messages.length > 0 && (
          <button
            onClick={handleReset}
            disabled={loading}
            className="px-4 py-3 text-[16px] text-text-muted hover:text-text-secondary border border-border-primary rounded-lg hover:border-interactive disabled:opacity-50 shrink-0 transition-colors"
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
          apiAuth={clerkStatus?.apiAuth ?? null}
          onApplyModel={handleApplyModel}
          onSaveApiKey={handleSaveApiKey}
          onClose={() => setShowSetup(false)}
        />
      )}
    </div>
  )
}
