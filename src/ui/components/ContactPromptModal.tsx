import { useState, useEffect, useRef } from 'react'
import { APP_MODE } from '../lib/auth'
import { api } from '../lib/client'
import { storageSet } from '../lib/storage'

export const CONTACT_PROMPT_SEEN_KEY = 'quoroom_contact_prompt_seen'
const isCloud = APP_MODE === 'cloud'

type Step = 'email' | 'code' | 'telegram'

interface ContactPromptModalProps {
  onClose: () => void
  onNavigateToClerk: () => void
}

export function ContactPromptModal({ onClose, onNavigateToClerk }: ContactPromptModalProps): React.JSX.Element {
  const [step, setStep] = useState<Step>(isCloud ? 'telegram' : 'email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deepLink, setDeepLink] = useState<string | null>(null)
  const [telegramPending, setTelegramPending] = useState(false)
  const [telegramVerified, setTelegramVerified] = useState(false)
  const [emailVerified, setEmailVerified] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [step])

  function markSeen(): void {
    storageSet(CONTACT_PROMPT_SEEN_KEY, '1')
  }

  function finish(): void {
    markSeen()
    onNavigateToClerk()
  }

  function skipToTelegram(): void {
    setError(null)
    setStep('telegram')
  }

  function skipAll(): void {
    markSeen()
    onClose()
  }

  async function handleEmailSend(): Promise<void> {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
      setError('Please enter your email.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.emailStart(trimmed)
      if (res.alreadyVerified) {
        setEmailVerified(true)
        setStep('telegram')
      } else {
        setStep('code')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code.')
    } finally {
      setBusy(false)
    }
  }

  async function handleCodeVerify(): Promise<void> {
    const trimmed = code.trim()
    if (trimmed.length !== 6) {
      setError('Enter the 6-digit code from your email.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.contacts.emailVerify(trimmed)
      setEmailVerified(true)
      setStep('telegram')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code.')
    } finally {
      setBusy(false)
    }
  }

  async function handleTelegramConnect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.telegramStart()
      setDeepLink(res.deepLink)
      setTelegramPending(true)
      window.open(res.deepLink, '_blank')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate link.')
    } finally {
      setBusy(false)
    }
  }

  async function handleTelegramCheck(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.telegramCheck()
      if (res.status === 'verified') {
        setTelegramVerified(true)
      } else if (res.status === 'expired') {
        setError('Link expired. Generate a new one.')
        setDeepLink(null)
        setTelegramPending(false)
      } else {
        setError('Not confirmed yet. Open the bot link and press Start, then check again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check failed.')
    } finally {
      setBusy(false)
    }
  }

  const allSteps: Step[] = isCloud ? ['telegram'] : ['email', 'code', 'telegram']
  const stepIdx = allSteps.indexOf(step)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8">
        {/* Step dots */}
        {allSteps.length > 1 && (
          <div className="flex gap-1.5 mb-6">
            {allSteps.map((s, i) => (
              <div
                key={s}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  i === stepIdx ? 'bg-interactive' : i < stepIdx ? 'bg-status-success' : 'bg-surface-tertiary'
                }`}
              />
            ))}
          </div>
        )}

        {/* Step 1: Email */}
        {step === 'email' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">Stay Reachable</h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              Clerk can help rule your swarm even when you're away from desktop. Add your email so Clerk can reach you for approvals, credentials, and key updates.
            </p>
            <div className="mb-4">
              <label className="block text-sm text-text-secondary mb-1">Email</label>
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleEmailSend() }}
                placeholder="your@email.com"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>
            {error && <p className="text-xs text-status-error mb-3">{error}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { void handleEmailSend() }}
                disabled={busy}
                className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {busy ? 'Sending...' : 'Send verification code'}
              </button>
              <button
                onClick={skipToTelegram}
                className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                Skip, set up Telegram instead
              </button>
            </div>
          </>
        )}

        {/* Step 2: Verify code */}
        {step === 'code' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">Check Your Inbox</h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              We sent a 6-digit code to <span className="text-text-primary font-medium">{email.trim().toLowerCase()}</span>. Enter it below to verify.
            </p>
            <div className="mb-4">
              <label className="block text-sm text-text-secondary mb-1">Verification code</label>
              <input
                ref={inputRef}
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim().length === 6) void handleCodeVerify() }}
                placeholder="000000"
                inputMode="numeric"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none tracking-widest text-center text-lg"
              />
            </div>
            {error && <p className="text-xs text-status-error mb-3">{error}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { void handleCodeVerify() }}
                disabled={busy || code.trim().length !== 6}
                className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {busy ? 'Verifying...' : 'Verify'}
              </button>
              <button
                onClick={skipToTelegram}
                className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                Skip, set up Telegram instead
              </button>
            </div>
          </>
        )}

        {/* Step 3: Telegram */}
        {step === 'telegram' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">
              {isCloud ? 'Stay Reachable' : emailVerified ? 'One More Thing' : 'Connect Telegram'}
            </h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              {isCloud
                ? 'Clerk can help run your swarm while you are away from desktop. Telegram is the fastest path for Clerk to reach you with approvals, credentials, and progress updates.'
                : 'Clerk can help rule your swarm while you are away from desktop. Telegram is the fastest way to stay connected.'
              } Click below to open our bot, press <span className="text-text-primary font-medium">Start</span>, then come back and check status.
            </p>

            {telegramVerified ? (
              <div className="mb-4 p-3 rounded-lg bg-surface-secondary text-sm text-status-success font-medium">
                Telegram connected!
              </div>
            ) : (
              <div className="space-y-3 mb-4">
                {!telegramPending ? (
                  <button
                    onClick={() => { void handleTelegramConnect() }}
                    disabled={busy}
                    className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
                  >
                    {busy ? 'Generating link...' : 'Open Telegram bot'}
                  </button>
                ) : (
                  <>
                    {deepLink && (
                      <a
                        href={deepLink}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full py-2.5 text-sm font-medium text-center text-interactive border border-interactive rounded-lg hover:bg-surface-hover transition-colors"
                      >
                        Open bot link again
                      </a>
                    )}
                    <button
                      onClick={() => { void handleTelegramCheck() }}
                      disabled={busy}
                      className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
                    >
                      {busy ? 'Checking...' : 'I pressed Start — check now'}
                    </button>
                  </>
                )}
              </div>
            )}

            {error && <p className="text-xs text-status-error mb-3">{error}</p>}

            <div className="flex flex-col gap-2">
              {telegramVerified ? (
                <button
                  onClick={finish}
                  className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
                >
                  Done
                </button>
              ) : (
                <button
                  onClick={skipAll}
                  className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
                >
                  Skip for now
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
