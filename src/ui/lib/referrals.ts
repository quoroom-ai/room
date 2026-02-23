const SHARE_CARD_IDS = new Set(['01', '02', '03', '04', '06', '07', '09', 'v1', 'v2', 'v3'])
const CODE_PARAM_KEYS = ['invite', 'code', 'ref', 'referral']

function decodeSegment(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function normalizeReferralCode(raw: string | null | undefined, maxLength = 20): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, '').slice(0, maxLength)
  return cleaned || null
}

function codeFromSearch(params: URLSearchParams): string | null {
  for (const key of CODE_PARAM_KEYS) {
    const value = normalizeReferralCode(params.get(key))
    if (value) return value
  }
  return null
}

function codeFromPath(pathname: string): string | null {
  const segments = pathname
    .split('/')
    .map(s => decodeSegment(s).trim())
    .filter(Boolean)

  if (segments.length === 0) return null
  const first = segments[0]?.toLowerCase()
  if (first === 'invite') {
    return normalizeReferralCode(segments[1])
  }
  if (first === 'share') {
    if (segments[2]) return normalizeReferralCode(segments[2])
    const maybeCode = segments[1]
    if (!maybeCode) return null
    if (SHARE_CARD_IDS.has(maybeCode.toLowerCase())) return null
    return normalizeReferralCode(maybeCode)
  }
  return null
}

export function extractReferralCodeFromLocation(loc: Pick<Location, 'search' | 'pathname' | 'hash'> = window.location): string | null {
  const searchCode = codeFromSearch(new URLSearchParams(loc.search))
  if (searchCode) return searchCode

  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash
  if (hash) {
    const [hashPath, hashQuery] = hash.split('?')
    if (hashQuery) {
      const hashSearchCode = codeFromSearch(new URLSearchParams(hashQuery))
      if (hashSearchCode) return hashSearchCode
    }
    const hashPathCode = codeFromPath(hashPath)
    if (hashPathCode) return hashPathCode
  }

  return codeFromPath(loc.pathname)
}

export function buildKeeperInviteLink(code: string, origin = 'https://quoroom.ai'): string {
  const normalized = normalizeReferralCode(code)
  if (!normalized) return origin
  return `${origin}/invite/${encodeURIComponent(normalized)}`
}

export function buildKeeperShareLink(code: string, shareId = 'v2', origin = 'https://quoroom.ai'): string {
  const normalized = normalizeReferralCode(code)
  if (!normalized) return `${origin}/share/${encodeURIComponent(shareId)}`
  return `${origin}/share/${encodeURIComponent(shareId)}/${encodeURIComponent(normalized)}`
}
