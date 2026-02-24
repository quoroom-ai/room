import { useEffect, useState } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useTheme } from '../hooks/useTheme'
import { api } from '../lib/client'
import { API_BASE, APP_MODE, clearToken, getToken } from '../lib/auth'
import { storageGet, storageSet } from '../lib/storage'
import * as notif from '../lib/notifications'
import type { InstallPrompt } from '../hooks/useInstallPrompt'
import { semverGt } from '../lib/releases'

interface SettingsPanelProps {
  advancedMode: boolean
  onAdvancedModeChange: (enabled: boolean) => void
  installPrompt: InstallPrompt
  onNavigate?: (tab: string) => void
}

interface UpdateInfo {
  latestVersion: string
  releaseUrl: string
  assets: { mac: string | null; windows: string | null; linux: string | null }
}

interface ServerStatus {
  version: string
  uptime: number
  dataDir?: string
  dbPath?: string
  claude?: { available: boolean; version?: string }
  codex?: { available: boolean; version?: string }
  resources?: { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number }
  updateInfo?: UpdateInfo | null
  readyUpdateVersion?: string | null
}

interface ContactStatusState {
  deploymentMode: 'local' | 'cloud'
  notifications: {
    email: boolean
    telegram: boolean
  }
  email: {
    value: string | null
    verified: boolean
    verifiedAt: string | null
    pending: boolean
    pendingExpiresAt: string | null
    resendRetryAfterSec: number
  }
  telegram: {
    id: string | null
    username: string | null
    firstName: string | null
    verified: boolean
    verifiedAt: string | null
    pending: boolean
    pendingExpiresAt: string | null
    botUsername: string
  }
}

export function SettingsPanel({ advancedMode, onAdvancedModeChange, installPrompt, onNavigate }: SettingsPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [notifications, setNotifications] = useState<boolean | null>(null)
  const [notifDenied, setNotifDenied] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateChecked, setUpdateChecked] = useState(false)
  const [claudePlan, setClaudePlan] = useState<'pro' | 'max' | 'api' | null>(null)
  const [chatGptPlan, setChatGptPlan] = useState<'plus' | 'pro' | 'api' | null>(null)
  const [queenModel, setQueenModel] = useState<string | null>(null)
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null)
  const [keeperReferralCode, setKeeperReferralCode] = useState<string | null>(null)
  const [keeperShareUrl, setKeeperShareUrl] = useState<string | null>(null)
  const [referralCopyStatus, setReferralCopyStatus] = useState<string | null>(null)
  const [contacts, setContacts] = useState<ContactStatusState | null>(null)
  const [cloudProfile, setCloudProfile] = useState<{ email: string | null; emailVerified: boolean | null; name: string | null } | null>(null)
  const [contactBusy, setContactBusy] = useState<string | null>(null)
  const [contactFeedback, setContactFeedback] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [emailInput, setEmailInput] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [telegramDeepLink, setTelegramDeepLink] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()

  async function handleCheckForUpdates(): Promise<void> {
    setUpdateChecking(true)
    try {
      await api.status.checkUpdate()
      const status = await api.status.getParts(['update'])
      setServerStatus(prev => ({ ...(prev ?? status), ...status }))
      setUpdateChecked(true)
    } catch {
      // ignore
    } finally {
      setUpdateChecking(false)
    }
  }

  async function refreshContactStatus(): Promise<void> {
    try {
      const payload = await api.contacts.status()
      setContacts(payload)
      if (!emailInput && payload.email.value) setEmailInput(payload.email.value)
    } catch {
      setContacts(null)
    }
  }

  async function setClerkNotificationChannel(channel: 'email' | 'telegram', enabled: boolean): Promise<void> {
    setContactBusy(`notify-${channel}`)
    try {
      const key = channel === 'email' ? 'clerk_notify_email' : 'clerk_notify_telegram'
      await api.settings.set(key, String(enabled))
      await refreshContactStatus()
      setContactFeedback({ kind: 'success', text: `Clerk ${channel} alerts ${enabled ? 'enabled' : 'disabled'}.` })
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to update notification preference.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleEmailStart(): Promise<void> {
    const email = emailInput.trim().toLowerCase()
    if (!email) {
      setContactFeedback({ kind: 'error', text: 'Enter an email address first.' })
      return
    }
    setContactBusy('email-start')
    try {
      const result = await api.contacts.emailStart(email)
      setEmailInput(email)
      if (result.alreadyVerified) {
        setContactFeedback({ kind: 'success', text: 'Email is already verified.' })
      } else {
        setContactFeedback({ kind: 'success', text: `Verification code sent to ${result.sentTo ?? email}.` })
      }
      await refreshContactStatus()
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to send verification code.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleEmailResend(): Promise<void> {
    setContactBusy('email-resend')
    try {
      const result = await api.contacts.emailResend()
      if (result.alreadyVerified) {
        setContactFeedback({ kind: 'success', text: 'Email is already verified.' })
      } else {
        setContactFeedback({ kind: 'success', text: `Verification code resent to ${result.sentTo ?? contacts?.email.value ?? 'your email'}.` })
      }
      await refreshContactStatus()
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to resend code.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleEmailVerify(): Promise<void> {
    const code = emailCode.trim()
    if (!code) {
      setContactFeedback({ kind: 'error', text: 'Enter the verification code.' })
      return
    }
    setContactBusy('email-verify')
    try {
      await api.contacts.emailVerify(code)
      setEmailCode('')
      setContactFeedback({ kind: 'success', text: 'Email verified.' })
      await refreshContactStatus()
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to verify email.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleTelegramStart(): Promise<void> {
    setContactBusy('telegram-start')
    try {
      const result = await api.contacts.telegramStart()
      setTelegramDeepLink(result.deepLink)
      setContactFeedback({ kind: 'info', text: 'Open the bot link, tap Start, then click Check status.' })
      await refreshContactStatus()
      window.open(result.deepLink, '_blank')
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to start Telegram verification.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleTelegramCheck(): Promise<void> {
    setContactBusy('telegram-check')
    try {
      const result = await api.contacts.telegramCheck()
      if (result.status === 'verified') {
        setContactFeedback({ kind: 'success', text: 'Telegram connected.' })
        setTelegramDeepLink(null)
      } else if (result.status === 'pending') {
        setContactFeedback({ kind: 'info', text: 'Still waiting for bot confirmation.' })
      } else if (result.status === 'expired' || result.status === 'missing') {
        setContactFeedback({ kind: 'error', text: 'Verification session expired. Generate a new bot link.' })
        setTelegramDeepLink(null)
      } else {
        setContactFeedback({ kind: 'info', text: 'No pending Telegram verification.' })
      }
      await refreshContactStatus()
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to check Telegram status.' })
    } finally {
      setContactBusy(null)
    }
  }

  async function handleTelegramDisconnect(): Promise<void> {
    setContactBusy('telegram-disconnect')
    try {
      await api.contacts.telegramDisconnect()
      setTelegramDeepLink(null)
      setContactFeedback({ kind: 'success', text: 'Telegram disconnected.' })
      await refreshContactStatus()
    } catch (error) {
      setContactFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to disconnect Telegram.' })
    } finally {
      setContactBusy(null)
    }
  }

  useEffect(() => {
    api.settings.get('notifications_enabled').then((v) => {
      setNotifications(v !== 'false')
    }).catch(() => setNotifications(true))

    Promise.all([
      api.status.getParts(['providers', 'resources']),
      api.status.getParts(['storage', 'update']),
    ])
      .then(([runtime, meta]) => setServerStatus({ ...runtime, ...meta }))
      .catch(() => {})

    api.settings.get('claude_plan').then((v) => {
      const valid = ['pro', 'max', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setClaudePlan(plan)
    }).catch(() => {})

    api.settings.get('chatgpt_plan').then((v) => {
      const valid = ['plus', 'pro', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setChatGptPlan(plan)
    }).catch(() => {})

    api.settings.get('queen_model').then((v) => {
      setQueenModel(v || null)
    }).catch(() => setQueenModel(null))

    api.settings.get('telemetry_enabled').then((v) => {
      setTelemetryEnabled(v !== 'false')
    }).catch(() => setTelemetryEnabled(true))

    api.settings.getReferral().then((payload) => {
      setKeeperReferralCode(payload.code)
      setKeeperShareUrl(payload.shareUrl)
    }).catch(() => {
      setKeeperReferralCode(null)
      setKeeperShareUrl(null)
    })

    void refreshContactStatus()

    api.auth.verify().then((payload) => {
      setCloudProfile(payload.profile)
    }).catch(() => {
      setCloudProfile(null)
    })
  }, [])

  async function setClaudePlanSetting(plan: 'pro' | 'max' | 'api' | null): Promise<void> {
    await api.settings.set('claude_plan', plan ?? '')
    setClaudePlan(plan)
  }

  async function setChatGptPlanSetting(plan: 'plus' | 'pro' | 'api' | null): Promise<void> {
    await api.settings.set('chatgpt_plan', plan ?? '')
    setChatGptPlan(plan)
  }

  async function setQueenModelSetting(model: string): Promise<void> {
    await api.settings.set('queen_model', model)
    setQueenModel(model)
  }

  async function toggleTelemetry(): Promise<void> {
    const next = !telemetryEnabled
    await api.settings.set('telemetry_enabled', String(next))
    setTelemetryEnabled(next)
  }

  async function toggleAdvancedMode(): Promise<void> {
    const next = !advancedMode
    await api.settings.set('advanced_mode', String(next))
    onAdvancedModeChange(next)
  }

  async function toggleNotifications(): Promise<void> {
    const next = !notifications
    if (next && notif.isSupported()) {
      const granted = await notif.requestPermission()
      if (!granted) {
        setNotifDenied(true)
        return
      }
      setNotifDenied(false)
    }
    await api.settings.set('notifications_enabled', String(next))
    setNotifications(next)
  }

  async function copyToClipboard(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setReferralCopyStatus(`${label} copied`)
    } catch {
      setReferralCopyStatus(`Failed to copy ${label.toLowerCase()}`)
    }
    window.setTimeout(() => setReferralCopyStatus(null), 2500)
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }

  function toggle(
    label: string,
    value: boolean | null,
    onChange: () => void,
    description?: string
  ): React.JSX.Element {
    const loading = value === null
    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{label}</span>
          <button
            onClick={onChange}
            disabled={loading}
            className={`w-9 h-5 rounded-full transition-colors relative ${
              loading ? 'bg-surface-tertiary' : value ? 'bg-interactive' : 'bg-text-muted'
            }`}
          >
            {!loading && (
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${
                  value ? 'left-4.5' : 'left-0.5'
                }`}
              />
            )}
          </button>
        </div>
        {description && (
          <p className="text-xs text-text-muted mt-0.5 leading-tight">{description}</p>
        )}
      </div>
    )
  }

  function row(label: string, value: string | null): React.JSX.Element {
    return (
      <div className="flex flex-col py-2">
        <span className="text-sm font-medium text-text-secondary">{label}</span>
        <span className="text-xs text-text-muted truncate selectable">{value ?? '\u2014'}</span>
      </div>
    )
  }

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string; icon: string }> = [
    { value: 'light', label: 'Light', icon: '\u2600' },
    { value: 'dark', label: 'Dark', icon: '\u263E' },
    { value: 'system', label: 'Auto', icon: '\u2699' },
  ]

  const preferencesSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Preferences</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-1 shadow-sm">
        {/* Theme toggle */}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Theme</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              {themeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    theme === opt.value
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{opt.icon} {opt.label}</button>
              ))}
            </div>
          </div>
        </div>
        {toggle('Notifications', notifications, toggleNotifications, 'Notify when workers or queen send messages')}
        {notifDenied && (
          <p className="text-xs text-status-error mt-0.5 leading-tight">Permission denied by browser. Allow notifications in browser settings.</p>
        )}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Clerk alert channels</span>
            <div className="flex gap-2">
              <button
                onClick={() => { void setClerkNotificationChannel('email', !(contacts?.notifications.email ?? true)) }}
                disabled={!contacts || contactBusy === 'notify-email'}
                className={`px-2.5 py-1 rounded-lg border text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  contacts?.notifications.email ?? true
                    ? 'bg-interactive text-text-invert border-interactive'
                    : 'bg-surface-primary text-text-secondary border-border-primary hover:bg-surface-hover'
                }`}
              >
                Email {contacts?.notifications.email ?? true ? 'On' : 'Off'}
              </button>
              <button
                onClick={() => { void setClerkNotificationChannel('telegram', !(contacts?.notifications.telegram ?? true)) }}
                disabled={!contacts || contactBusy === 'notify-telegram'}
                className={`px-2.5 py-1 rounded-lg border text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  contacts?.notifications.telegram ?? true
                    ? 'bg-interactive text-text-invert border-interactive'
                    : 'bg-surface-primary text-text-secondary border-border-primary hover:bg-surface-hover'
                }`}
              >
                Telegram {contacts?.notifications.telegram ?? true ? 'On' : 'Off'}
              </button>
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">Global setting for Clerk outreach. Default is both.</p>
        </div>
        {toggle('Advanced mode', advancedMode, toggleAdvancedMode, 'Show memory, watches, results tabs and extra controls')}
        {toggle('Telemetry', telemetryEnabled, toggleTelemetry, 'Send heartbeats to quoroom.ai (room appears in online counter and leaderboard)')}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Claude plan</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              <button
                onClick={() => setClaudePlanSetting(null)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  claudePlan === null
                    ? 'bg-text-muted text-text-invert'
                    : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                }`}
              >{'\u2014'}</button>
              {(['pro', 'max', 'api'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setClaudePlanSetting(p)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    claudePlan === p
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">Optimizes queen cycle gap and max turns for your plan's token limits</p>
        </div>
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">ChatGPT plan</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              <button
                onClick={() => setChatGptPlanSetting(null)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  chatGptPlan === null
                    ? 'bg-text-muted text-text-invert'
                    : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                }`}
              >{'\u2014'}</button>
              {(['plus', 'pro', 'api'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setChatGptPlanSetting(p)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    chatGptPlan === p
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">Optimizes queen defaults when using Codex. Plus and Pro have different rate limits.</p>
        </div>
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Queen model</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              {([
                ['claude', 'Claude'],
                ['codex', 'Codex'],
                ['openai:gpt-4o-mini', 'OpenAI API'],
                ['anthropic:claude-3-5-sonnet-latest', 'Claude API']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setQueenModelSetting(id)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    (queenModel ?? 'claude') === id
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">Default queen provider for new rooms. API modes require key in room credentials or env.</p>
        </div>
      </div>
    </div>
  )

  const referralSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Referral</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-3 shadow-sm">
        <div className="py-1">
          <label className="block text-sm text-text-secondary mb-1">Your Keeper Code</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={keeperReferralCode ?? ''}
              readOnly
              placeholder="Loading..."
              className="flex-1 px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <button
              onClick={() => { if (keeperReferralCode) void copyToClipboard(keeperReferralCode, 'Code') }}
              disabled={!keeperReferralCode}
              className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Copy
            </button>
          </div>
        </div>
        <div className="py-1">
          <label className="block text-sm text-text-secondary mb-1">Sharable Invite Link</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={keeperShareUrl ?? ''}
              readOnly
              placeholder="Loading..."
              className="flex-1 px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <button
              onClick={() => { if (keeperShareUrl) void copyToClipboard(keeperShareUrl, 'Link') }}
              disabled={!keeperShareUrl}
              className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Copy
            </button>
          </div>
        </div>
        {referralCopyStatus && <p className="text-xs text-text-muted">{referralCopyStatus}</p>}
        <p className="text-xs text-text-muted leading-tight">Use this code and link when inviting new keepers into your network.</p>
      </div>
    </div>
  )

  const cloudEmail = APP_MODE === 'cloud' ? cloudProfile?.email ?? null : null
  const cloudEmailVerified = cloudProfile?.emailVerified === true
  const emailStatusText = contacts?.email.verified
    ? 'Verified'
    : contacts?.email.pending
      ? 'Pending verification'
      : 'Not verified'
  const telegramStatusText = contacts?.telegram.verified
    ? `Connected${contacts.telegram.username ? ` as @${contacts.telegram.username}` : ''}`
    : contacts?.telegram.pending
      ? 'Pending verification'
      : 'Not connected'

  const contactsSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Clerk Communications</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-4 shadow-sm">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Email</span>
            <span className={contacts?.email.verified || cloudEmailVerified ? 'text-status-success' : 'text-text-muted'}>
              {APP_MODE === 'cloud' && cloudEmail ? (cloudEmailVerified ? 'Verified' : 'Unverified') : emailStatusText}
            </span>
          </div>
          {APP_MODE === 'cloud' && cloudEmail ? (
            <div className="text-xs text-text-muted break-all">
              {cloudEmail}
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={emailInput}
                  placeholder="your@email.com"
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                />
                <button
                  onClick={() => { void handleEmailStart() }}
                  disabled={contactBusy === 'email-start'}
                  className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {contactBusy === 'email-start' ? 'Sending...' : 'Send code'}
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={emailCode}
                  placeholder="6-digit code"
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                />
                <button
                  onClick={() => { void handleEmailVerify() }}
                  disabled={contactBusy === 'email-verify' || emailCode.trim().length !== 6}
                  className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {contactBusy === 'email-verify' ? 'Verifying...' : 'Verify'}
                </button>
                <button
                  onClick={() => { void handleEmailResend() }}
                  disabled={contactBusy === 'email-resend' || (contacts?.email.resendRetryAfterSec ?? 0) > 0}
                  className="px-3 py-2 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {contactBusy === 'email-resend'
                    ? 'Resending...'
                    : (contacts?.email.resendRetryAfterSec ?? 0) > 0
                      ? `Resend (${contacts?.email.resendRetryAfterSec}s)`
                      : 'Resend'}
                </button>
              </div>
            </>
          )}
          {contacts?.email.pendingExpiresAt && !contacts.email.verified && (
            <p className="text-xs text-text-muted">Code expires at {new Date(contacts.email.pendingExpiresAt).toLocaleTimeString()}.</p>
          )}
        </div>

        <div className="border-t border-border-secondary pt-3 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Telegram <span className="text-text-muted font-normal">(preferred)</span></span>
            <span className={contacts?.telegram.verified ? 'text-status-success' : 'text-text-muted'}>
              {telegramStatusText}
            </span>
          </div>
          {!contacts?.telegram.verified && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { void handleTelegramStart() }}
                disabled={contactBusy === 'telegram-start'}
                className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {contactBusy === 'telegram-start' ? 'Generating link...' : 'Open bot link'}
              </button>
              <button
                onClick={() => { void handleTelegramCheck() }}
                disabled={contactBusy === 'telegram-check' || !contacts?.telegram.pending}
                className="px-3 py-2 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {contactBusy === 'telegram-check' ? 'Checking...' : 'Check status'}
              </button>
            </div>
          )}
          {telegramDeepLink && (
            <a
              href={telegramDeepLink}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-interactive hover:underline break-all inline-block"
            >
              {telegramDeepLink}
            </a>
          )}
          {contacts?.telegram.verified && (
            <div className="flex flex-wrap gap-2">
              <div className="text-xs text-text-muted py-2">
                Bot: @{contacts.telegram.botUsername}
              </div>
              <button
                onClick={() => { void handleTelegramDisconnect() }}
                disabled={contactBusy === 'telegram-disconnect'}
                className="px-3 py-2 rounded-lg border border-border-primary text-text-secondary text-sm hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {contactBusy === 'telegram-disconnect' ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          )}
          {contacts?.telegram.pendingExpiresAt && contacts.telegram.pending && (
            <p className="text-xs text-text-muted">Verification link expires at {new Date(contacts.telegram.pendingExpiresAt).toLocaleTimeString()}.</p>
          )}
        </div>

        {contactFeedback && (
          <p className={`text-xs ${
            contactFeedback.kind === 'success'
              ? 'text-status-success'
              : contactFeedback.kind === 'error'
                ? 'text-status-error'
                : 'text-text-muted'
          }`}>
            {contactFeedback.text}
          </p>
        )}
        <p className="text-xs text-text-muted leading-tight">How Clerk reaches you when you're not at your computer.</p>
      </div>
    </div>
  )

  const connectionSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Connection</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-1.5 shadow-sm">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">API Server</span>
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${serverStatus ? 'bg-status-success' : 'bg-status-error'}`} />
            <span className={serverStatus ? 'text-status-success' : 'text-status-error'}>
              {serverStatus ? 'Connected' : 'Disconnected'}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Server URL</span>
          <span className="text-text-muted font-mono text-xs">{API_BASE || location.origin}</span>
        </div>
        {API_BASE && API_BASE.includes('localhost') && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Port</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                defaultValue={storageGet('quoroom_port') || '3700'}
                className="w-16 px-2 py-1 text-xs border border-border-primary rounded text-center font-mono bg-surface-primary text-text-primary"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    storageSet('quoroom_port', (e.target as HTMLInputElement).value)
                    clearToken()
                    location.reload()
                  }
                }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Claude Code</span>
          <span className="flex items-center gap-1.5">
            {claudePlan && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                {claudePlan}
              </span>
            )}
            <span className={serverStatus?.claude?.available ? 'text-status-success' : 'text-text-muted'}>
              {serverStatus === null
                ? '...'
                : serverStatus.claude?.available
                  ? serverStatus.claude.version || 'Found'
                  : 'Not found'}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Codex</span>
          <span className="flex items-center gap-1.5">
            {chatGptPlan && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                {chatGptPlan}
              </span>
            )}
            <span className={serverStatus?.codex?.available ? 'text-status-success' : 'text-text-muted'}>
              {serverStatus === null
                ? '...'
                : serverStatus.codex?.available
                  ? serverStatus.codex.version || 'Found'
                  : 'Not found'}
            </span>
          </span>
        </div>
        {serverStatus?.resources && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Load</span>
            <span className={serverStatus.resources.memUsedPct > 85 || serverStatus.resources.loadAvg1m > serverStatus.resources.cpuCount * 0.8 ? 'text-status-warning' : 'text-text-muted'}>
              CPU {Math.round(serverStatus.resources.loadAvg1m / serverStatus.resources.cpuCount * 100)}%
              {' \u00B7 '}RAM {serverStatus.resources.memUsedPct}%
            </span>
          </div>
        )}
        {serverStatus && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Uptime</span>
            <span className="text-text-muted">{formatUptime(serverStatus.uptime)}</span>
          </div>
        )}
      </div>
    </div>
  )

  const appSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">App</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-1.5 shadow-sm">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Installation</span>
          {installPrompt.isInstalled ? (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-status-success" />
              <span className="text-status-success">Installed</span>
            </span>
          ) : installPrompt.canInstall ? (
            <button
              onClick={installPrompt.install}
              className="text-sm px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover font-medium transition-colors"
            >
              Install
            </button>
          ) : installPrompt.isManualInstallPlatform ? (
            <button
              onClick={() => onNavigate?.('help')}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
            >
              Manual install &rarr;
            </button>
          ) : (
            <button
              onClick={() => onNavigate?.('help')}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
            >
              Help tab &rarr;
            </button>
          )}
        </div>
        <p className="text-xs text-text-muted leading-tight">
          Standalone app with Dock/taskbar icon and badge notifications.
        </p>
      </div>
    </div>
  )

  const serverSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Server</h3>
      <div className="bg-surface-secondary rounded-lg p-3 divide-y divide-border-secondary shadow-sm">
        <div className="flex items-center justify-between text-sm py-2">
          <span className="font-medium text-text-secondary">Version</span>
          <div className="flex items-center gap-2">
            <span className="text-text-muted">{serverStatus?.version ?? '...'}</span>
            {(() => {
              const ui = serverStatus?.updateInfo
              const hasUpdate = ui && serverStatus && semverGt(ui.latestVersion, serverStatus.version)
              if (hasUpdate) return null
              if (updateChecking) return <span className="text-text-muted">Checking...</span>
              if (updateChecked) return <span className="text-status-success">Up to date</span>
              return (
                <button
                  onClick={() => void handleCheckForUpdates()}
                  className="px-2.5 py-1 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  Check
                </button>
              )
            })()}
          </div>
        </div>
        {(() => {
          const ui = serverStatus?.updateInfo
          if (!ui || !serverStatus) return null
          if (!semverGt(ui.latestVersion, serverStatus.version)) return null
          const isReady = !!serverStatus.readyUpdateVersion
          return (
            <div className="flex items-center justify-between text-sm py-2">
              <span className="font-medium text-status-success">
                v{ui.latestVersion} {isReady ? 'ready' : 'available'}
              </span>
              {isReady ? (
                <button
                  onClick={async () => {
                    await fetch(`${API_BASE}/api/server/update-restart`, { method: 'POST' })
                    setTimeout(() => {
                      const poll = setInterval(async () => {
                        try {
                          const res = await fetch(`${API_BASE}/api/status`)
                          if (res.ok) { clearInterval(poll); window.location.reload() }
                        } catch { /* server still restarting */ }
                      }, 1000)
                      setTimeout(() => clearInterval(poll), 30_000)
                    }, 2000)
                  }}
                  className="px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  Restart to Update
                </button>
              ) : (
                <button
                  onClick={async () => {
                    const token = await getToken()
                    const a = document.createElement('a')
                    a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }}
                  className="px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  Download
                </button>
              )}
            </div>
          )
        })()}
        {row('Database', serverStatus?.dbPath ?? null)}
        {row('Data Directory', serverStatus?.dataDir ?? null)}
      </div>
    </div>
  )

  const actionsSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Actions</h3>
      <div className="bg-surface-secondary rounded-lg p-3 shadow-sm">
        <div className={`${wide ? 'grid grid-cols-2 gap-3' : 'space-y-3'}`}>
          <button
            onClick={() => window.open('https://github.com/quoroom-ai/room/issues/new')}
            className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
          >
            Report Bug
          </button>
          <button
            onClick={() => window.open('mailto:hello@quoroom.ai')}
            className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
          >
            Email Developer
          </button>
          <button
            onClick={() => window.open('https://github.com/quoroom-ai/room')}
            className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
          >
            Star on GitHub
          </button>
          <button
            onClick={() => window.open('mailto:updates@email.quoroom.ai?subject=Subscribe&body=Subscribe me for Quoroom updates')}
            className="w-full py-2 text-sm bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
          >
            Subscribe for Updates
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className="p-5">
      {wide ? (
        <div className="grid grid-cols-2 gap-5 items-start">
          <div className="space-y-5">
            {referralSection}
            {contactsSection}
            {preferencesSection}
            {appSection}
            {actionsSection}
          </div>
          <div className="space-y-5">
            {connectionSection}
            {serverSection}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {referralSection}
          {contactsSection}
          {preferencesSection}
          {connectionSection}
          {appSection}
          {serverSection}
          {actionsSection}
        </div>
      )}
    </div>
  )
}
