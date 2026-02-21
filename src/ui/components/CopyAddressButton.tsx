import { useState, useRef } from 'react'

interface CopyAddressButtonProps {
  address: string
  className?: string
}

export function CopyAddressButton({ address, className = '' }: CopyAddressButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function handleClick(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = address
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      // silently fail
    }
  }

  return (
    <button
      onClick={handleClick}
      className={`shrink-0 p-0.5 rounded text-text-muted hover:text-text-secondary transition-colors ${className}`}
      title="Copy address"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}
