interface InstallProgressLineLike {
  text: string
}

interface InstallProgressSessionLike {
  status: 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'
  active: boolean
  lines: InstallProgressLineLike[]
}

export interface LocalInstallProgressState {
  percent: number | null
  indeterminate: boolean
}

const PERCENT_PATTERN = /(^|[^0-9])(\d{1,3}(?:\.\d+)?)\s*%/g

export function parseProgressPercentFromText(text: string): number | null {
  const matches = [...text.matchAll(PERCENT_PATTERN)]
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const value = Number.parseFloat(matches[i][2] ?? '')
    if (!Number.isFinite(value) || value < 0 || value > 100) continue
    return Math.round(value)
  }
  return null
}

export function extractLatestProgressPercent(lines: InstallProgressLineLike[]): number | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const percent = parseProgressPercentFromText(lines[i].text)
    if (percent != null) return percent
  }
  return null
}

export function getLocalInstallProgressState(session: InstallProgressSessionLike | null): LocalInstallProgressState {
  if (!session) return { percent: null, indeterminate: false }

  const percent = extractLatestProgressPercent(session.lines)
  if (percent != null) return { percent, indeterminate: false }
  if (session.status === 'completed') return { percent: 100, indeterminate: false }
  if (session.active || session.status === 'starting' || session.status === 'running') {
    return { percent: null, indeterminate: true }
  }
  return { percent: null, indeterminate: false }
}
