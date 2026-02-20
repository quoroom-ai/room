export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const date = new Date(iso)
  const diffMs = Date.now() - date.getTime()

  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  return date.toLocaleDateString()
}

export function formatDateTimeShort(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
