import { useState, useEffect } from 'react'
import { storageSet } from '../lib/storage'
import { API_BASE } from '../lib/auth'
import {
  detectPlatform,
  pickLatestStableRelease,
  parseReleaseAssets,
  bestDownloadUrl,
  type ReleaseAssets,
  type GithubRelease,
} from '../lib/releases'

interface ConnectPageProps {
  port: string
  onRetry: () => void
}

const RELEASES_PAGE = 'https://github.com/quoroom-ai/room/releases'

const PLATFORM_INFO: Record<string, { label: string; note: string; steps: string[] }> = {
  mac: {
    label: 'Download for macOS',
    note: 'Apple Silicon + Intel',
    steps: ['Open the downloaded .pkg file', 'Follow the installer steps'],
  },
  windows: {
    label: 'Download for Windows',
    note: '64-bit',
    steps: ['Run the downloaded installer', 'Follow the setup wizard'],
  },
  linux: {
    label: 'Download for Linux',
    note: 'x64',
    steps: ['Install: sudo dpkg -i quoroom_*.deb'],
  },
}

function useReleaseAssets(): { assets: ReleaseAssets; releaseUrl: string } {
  const empty: ReleaseAssets = {
    mac: { installer: null, archive: null },
    windows: { installer: null, archive: null },
    linux: { installer: null, archive: null },
  }
  const [assets, setAssets] = useState<ReleaseAssets>(empty)
  const [releaseUrl, setReleaseUrl] = useState<string>(RELEASES_PAGE)

  useEffect(() => {
    fetch('https://api.github.com/repos/quoroom-ai/room/releases?per_page=20')
      .then(r => r.ok ? r.json() as Promise<GithubRelease[]> : null)
      .then((releases) => {
        if (!releases || releases.length === 0) return
        const latest = pickLatestStableRelease(releases)
        if (!latest?.assets) return
        setReleaseUrl(latest.html_url || RELEASES_PAGE)
        setAssets(parseReleaseAssets(latest))
      })
      .catch(() => {})
  }, [])
  return { assets, releaseUrl }
}

export function ConnectPage({ port, onRetry }: ConnectPageProps): React.JSX.Element {
  const [editPort, setEditPort] = useState(port)
  const [retrying, setRetrying] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [showDev, setShowDev] = useState(false)
  const platform = detectPlatform()
  const info = PLATFORM_INFO[platform]
  const { assets, releaseUrl } = useReleaseAssets()

  function handleRetry(): void {
    storageSet('quoroom_port', editPort)
    setRestartError(null)
    setRetrying(true)
    onRetry()
  }

  async function handleRestart(): Promise<void> {
    storageSet('quoroom_port', editPort)
    setRestartError(null)
    setRestarting(true)
    try {
      const res = await fetch(`${API_BASE}/api/server/restart`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTimeout(() => {
        setRestarting(false)
        handleRetry()
      }, 1800)
    } catch {
      setRestarting(false)
      setRestartError('Restart could not be triggered. Start server manually with "quoroom serve".')
    }
  }

  return (
    <div className="flex flex-col h-screen bg-surface-primary items-center justify-center px-4 overflow-y-auto">
      <div className="max-w-sm w-full py-8 space-y-6 text-center">
        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-text-primary">Quoroom</h1>
          <p className="text-sm text-text-muted mt-1">Autonomous AI agent collective engine</p>
        </div>

        {/* Status */}
        <div className="bg-surface-secondary rounded-lg p-4 space-y-2 shadow-sm">
          <div className="flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-error" />
            <span className="text-sm text-status-error font-medium">Local server not reachable</span>
          </div>
          <p className="text-xs text-text-muted">
            Quoroom runs entirely on your machine. Download and start it to continue.
          </p>
        </div>

        {/* Download — primary action */}
        <div className="space-y-3">
          <a
            href={bestDownloadUrl(assets[platform], releaseUrl)}
            className="block w-full py-3 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors shadow-sm"
          >
            {info.label}
          </a>
          <p className="text-xs text-text-muted">
            {info.note} &middot; No dependencies needed
            {assets[platform].archive && assets[platform].installer && (
              <> &middot; <a href={assets[platform].archive!} className="underline hover:text-text-secondary">portable archive</a></>
            )}
          </p>

          {/* Other platforms */}
          <div className="flex items-center justify-center gap-3 text-xs">
            {platform !== 'mac' && (
              <a href={bestDownloadUrl(assets.mac, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">macOS</a>
            )}
            {platform !== 'windows' && (
              <a href={bestDownloadUrl(assets.windows, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">Windows</a>
            )}
            {platform !== 'linux' && (
              <a href={bestDownloadUrl(assets.linux, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">Linux</a>
            )}
          </div>
        </div>

        {/* Quick start after download */}
        <div className="bg-surface-secondary rounded-lg p-4 text-left space-y-2 shadow-sm">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide">After downloading</p>
          <div className="space-y-1.5">
            {info.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{i + 1}.</span>
                <span className="text-sm text-text-secondary">{step}</span>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{info.steps.length + 1}.</span>
              <span className="text-sm text-text-secondary">Run <code className="text-xs bg-surface-tertiary px-1.5 py-0.5 rounded font-mono text-text-primary">quoroom serve</code></span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{info.steps.length + 2}.</span>
              <span className="text-sm text-text-muted">This page will redirect automatically</span>
            </div>
          </div>
        </div>

        {/* Developer install — collapsible */}
        <div>
          <button
            onClick={() => setShowDev(!showDev)}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            {showDev ? 'Hide' : 'Show'} developer install (npm / Homebrew)
          </button>
          {showDev && (
            <div className="mt-2 bg-surface-secondary rounded-lg p-4 text-left space-y-2 shadow-sm">
              <div className="flex items-start gap-2">
                <span className="text-xs text-text-muted shrink-0">npm:</span>
                <code className="text-xs bg-surface-tertiary px-2 py-1 rounded text-text-primary font-mono">npm install -g quoroom && quoroom serve</code>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs text-text-muted shrink-0">brew:</span>
                <code className="text-xs bg-surface-tertiary px-2 py-1 rounded text-text-primary font-mono">brew install quoroom-ai/quoroom/quoroom</code>
              </div>
            </div>
          )}
        </div>

        {/* Port + Retry */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-center gap-2">
          <span className="text-xs text-text-muted">Port:</span>
          <input
            type="number"
            value={editPort}
            onChange={(e) => setEditPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRetry() }}
            className="w-16 px-2 py-1 text-sm border border-border-primary rounded-lg text-center font-mono bg-surface-primary text-text-primary"
          />
          <button
            onClick={handleRetry}
            disabled={retrying || restarting}
            className="text-sm px-4 py-1.5 text-text-secondary hover:text-text-primary border border-border-primary hover:border-interactive rounded-lg transition-colors disabled:opacity-40"
          >
            {retrying ? 'Connecting...' : 'Retry'}
          </button>
          <button
            onClick={() => void handleRestart()}
            disabled={retrying || restarting}
            className="text-sm px-4 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors disabled:opacity-40"
          >
            {restarting ? 'Restarting...' : 'Restart'}
          </button>
          </div>
          <p className="text-[11px] text-text-muted text-center">
            Retry checks connection only. Restart relaunches local server, then retries.
          </p>
          {restartError && (
            <p className="text-[11px] text-status-error text-center">{restartError}</p>
          )}
        </div>

        {/* Links */}
        <div className="flex items-center justify-center gap-3">
          <a href="https://github.com/quoroom-ai/room" target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">GitHub</a>
          <span className="text-border-primary">|</span>
          <a href="https://github.com/quoroom-ai/room/releases" target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">All releases</a>
          <span className="text-border-primary">|</span>
          <a href="https://github.com/quoroom-ai/room/issues/new" target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">Report Bug</a>
          <span className="text-border-primary">|</span>
          <a href="https://x.com/VTrofimchuk" target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">Developer</a>
        </div>

        {/* Privacy */}
        <p className="text-xs text-text-muted opacity-60">
          100% local — all data stays on your machine. This page contains no backend.
        </p>
      </div>
    </div>
  )
}
