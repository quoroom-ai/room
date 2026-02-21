import { useState, useEffect, useRef } from 'react'

interface PromptDialogProps {
  title: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  type?: 'text' | 'password'
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog({
  title,
  placeholder,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  type = 'text',
  onConfirm,
  onCancel,
}: PromptDialogProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSubmit(): void {
    const trimmed = value.trim()
    if (trimmed) onConfirm(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">{title}</h3>
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={placeholder}
          className="w-full bg-surface-secondary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-tertiary rounded-lg hover:bg-surface-hover transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="px-4 py-2 text-sm font-medium bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
