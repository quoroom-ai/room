/**
 * Shared utilities for GitHub release detection and platform-specific download URLs.
 * Used by ConnectPage (download links when server unreachable) and update check logic.
 */

export type Platform = 'mac' | 'windows' | 'linux'

export interface PlatformAssets {
  installer: string | null
  archive: string | null
}

export interface ReleaseAssets {
  mac: PlatformAssets
  windows: PlatformAssets
  linux: PlatformAssets
}

export interface GithubReleaseAsset {
  name: string
  browser_download_url: string
}

export interface GithubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets?: GithubReleaseAsset[]
}

export function detectPlatform(): Platform {
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

export function isTestTag(tag: string): boolean {
  return /-test/i.test(tag)
}

export function pickLatestStableRelease(releases: GithubRelease[]): GithubRelease | null {
  for (const r of releases) {
    if (r.draft || r.prerelease) continue
    if (isTestTag(r.tag_name)) continue
    return r
  }
  return null
}

export function parseReleaseAssets(release: GithubRelease): ReleaseAssets {
  const result: ReleaseAssets = {
    mac: { installer: null, archive: null },
    windows: { installer: null, archive: null },
    linux: { installer: null, archive: null },
  }
  for (const a of release.assets ?? []) {
    const { name, browser_download_url: url } = a
    if (name.endsWith('.pkg')) result.mac.installer = url
    else if (name.includes('darwin-universal') && name.endsWith('.tar.gz')) result.mac.archive = url
    else if (name.toLowerCase().includes('setup') && name.endsWith('.exe')) result.windows.installer = url
    else if (name.includes('win-x64') && name.endsWith('.zip')) result.windows.archive = url
    else if (name.endsWith('.deb')) result.linux.installer = url
    else if (name.includes('linux-x64') && name.endsWith('.tar.gz')) result.linux.archive = url
  }
  return result
}

export function bestDownloadUrl(pa: PlatformAssets, fallbackReleaseUrl: string): string {
  return pa.installer || pa.archive || fallbackReleaseUrl
}

/** Returns true if version string a is greater than b (e.g. '1.2.3' > '1.1.0'). */
export function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va > vb) return true
    if (va < vb) return false
  }
  return false
}
