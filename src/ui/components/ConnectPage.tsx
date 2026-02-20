import { useState, useEffect } from 'react'

interface ConnectPageProps {
  port: string
  onRetry: () => void
}

function detectPlatform(): 'mac' | 'windows' | 'linux' {
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform?.toLowerCase()
    || navigator.platform?.toLowerCase() || ''
  if (platform.includes('mac')) return 'mac'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux')) return 'linux'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'mac'
  if (ua.includes('win')) return 'windows'
  return 'linux'
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

interface PlatformAssets { installer: string | null; archive: string | null }
interface ReleaseAssets { mac: PlatformAssets; windows: PlatformAssets; linux: PlatformAssets }
interface GithubReleaseAsset { name: string; browser_download_url: string }
interface GithubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets?: GithubReleaseAsset[]
}

function isTestTag(tag: string): boolean {
  return /-test/i.test(tag)
}

function pickLatestStableRelease(releases: GithubRelease[]): GithubRelease | null {
  for (const r of releases) {
    if (r.draft || r.prerelease) continue
    if (isTestTag(r.tag_name)) continue
    return r
  }
  return null
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
        const result: ReleaseAssets = {
          mac: { installer: null, archive: null },
          windows: { installer: null, archive: null },
          linux: { installer: null, archive: null },
        }
        for (const a of latest.assets) {
          const { name, browser_download_url: url } = a
          if (name.endsWith('.pkg')) result.mac.installer = url
          else if (name.includes('darwin-universal') && name.endsWith('.tar.gz')) result.mac.archive = url
          else if (name.includes('setup.exe')) result.windows.installer = url
          else if (name.includes('win-x64') && name.endsWith('.zip')) result.windows.archive = url
          else if (name.endsWith('.deb')) result.linux.installer = url
          else if (name.includes('linux-x64') && name.endsWith('.tar.gz')) result.linux.archive = url
        }
        setAssets(result)
      })
      .catch(() => {})
  }, [])
  return { assets, releaseUrl }
}

function bestUrl(pa: PlatformAssets, fallbackReleaseUrl: string): string {
  return pa.installer || pa.archive || fallbackReleaseUrl
}

export function ConnectPage({ port, onRetry }: ConnectPageProps): React.JSX.Element {
  const [editPort, setEditPort] = useState(port)
  const [retrying, setRetrying] = useState(false)
  const [showDev, setShowDev] = useState(false)
  const platform = detectPlatform()
  const info = PLATFORM_INFO[platform]
  const { assets, releaseUrl } = useReleaseAssets()

  function handleRetry(): void {
    localStorage.setItem('quoroom_port', editPort)
    setRetrying(true)
    onRetry()
  }

  return (
    <div className="flex flex-col h-screen bg-white items-center justify-center px-4 overflow-y-auto">
      <div className="max-w-sm w-full py-8 space-y-5 text-center">
        {/* Title */}
        <div>
          <h1 className="text-lg font-semibold text-gray-800">Quoroom</h1>
          <p className="text-xs text-gray-400 mt-0.5">Autonomous AI agent collective engine</p>
        </div>

        {/* Status */}
        <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            <span className="text-xs text-red-500 font-medium">Local server not reachable</span>
          </div>
          <p className="text-[10px] text-gray-400">
            Quoroom runs entirely on your machine. Download and start it to continue.
          </p>
        </div>

        {/* Download — primary action */}
        <div className="space-y-2">
          <a
            href={bestUrl(assets[platform], releaseUrl)}
            className="block w-full py-2.5 text-sm font-medium text-white bg-gray-800 hover:bg-gray-900 rounded transition-colors"
          >
            {info.label}
          </a>
          <p className="text-[10px] text-gray-400">
            {info.note} &middot; No dependencies needed
            {assets[platform].archive && assets[platform].installer && (
              <> &middot; <a href={assets[platform].archive!} className="underline hover:text-gray-600">portable archive</a></>
            )}
          </p>

          {/* Other platforms */}
          <div className="flex items-center justify-center gap-2 text-[10px]">
            {platform !== 'mac' && (
              <a href={bestUrl(assets.mac, releaseUrl)} className="text-gray-400 hover:text-gray-600 underline">macOS</a>
            )}
            {platform !== 'windows' && (
              <a href={bestUrl(assets.windows, releaseUrl)} className="text-gray-400 hover:text-gray-600 underline">Windows</a>
            )}
            {platform !== 'linux' && (
              <a href={bestUrl(assets.linux, releaseUrl)} className="text-gray-400 hover:text-gray-600 underline">Linux</a>
            )}
          </div>
        </div>

        {/* Quick start after download */}
        <div className="bg-gray-50 rounded-lg p-3 text-left space-y-1.5">
          <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">After downloading</p>
          <div className="space-y-1">
            {info.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[10px] text-gray-400 font-mono mt-0.5 shrink-0">{i + 1}.</span>
                <span className="text-xs text-gray-600">{step}</span>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-gray-400 font-mono mt-0.5 shrink-0">{info.steps.length + 1}.</span>
              <span className="text-xs text-gray-600">Run <code className="text-[11px] bg-gray-200 px-1 py-0.5 rounded font-mono">quoroom serve</code></span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-gray-400 font-mono mt-0.5 shrink-0">{info.steps.length + 2}.</span>
              <span className="text-xs text-gray-500">This page will redirect automatically</span>
            </div>
          </div>
        </div>

        {/* Developer install — collapsible */}
        <div>
          <button
            onClick={() => setShowDev(!showDev)}
            className="text-[10px] text-gray-400 hover:text-gray-600"
          >
            {showDev ? 'Hide' : 'Show'} developer install (npm / Homebrew)
          </button>
          {showDev && (
            <div className="mt-2 bg-gray-50 rounded-lg p-3 text-left space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-gray-500 shrink-0">npm:</span>
                <code className="text-[11px] bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono">npm install -g quoroom && quoroom serve</code>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-gray-500 shrink-0">brew:</span>
                <code className="text-[11px] bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono">brew install quoroom-ai/quoroom/quoroom</code>
              </div>
            </div>
          )}
        </div>

        {/* Port + Retry */}
        <div className="flex items-center justify-center gap-2">
          <span className="text-[10px] text-gray-400">Port:</span>
          <input
            type="number"
            value={editPort}
            onChange={(e) => setEditPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRetry() }}
            className="w-16 px-1.5 py-0.5 text-xs border border-gray-200 rounded text-center font-mono"
          />
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="text-xs px-3 py-1 text-gray-600 hover:text-gray-800 border border-gray-200 hover:border-gray-300 rounded transition-colors disabled:opacity-40"
          >
            {retrying ? 'Connecting...' : 'Retry'}
          </button>
        </div>

        {/* Links */}
        <div className="flex items-center justify-center gap-3">
          <a href="https://github.com/quoroom-ai/room" target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-400 hover:text-gray-600">GitHub</a>
          <span className="text-gray-200">|</span>
          <a href="https://github.com/quoroom-ai/room/releases" target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-400 hover:text-gray-600">All releases</a>
          <span className="text-gray-200">|</span>
          <a href="https://github.com/quoroom-ai/room/issues/new" target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-400 hover:text-gray-600">Report Bug</a>
        </div>

        {/* Privacy */}
        <p className="text-[10px] text-gray-300">
          100% local — all data stays on your machine. This page contains no backend.
        </p>
      </div>
    </div>
  )
}
