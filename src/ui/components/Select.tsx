import { useState, useRef, useEffect, useCallback } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  variant?: 'default' | 'inline'
  disabled?: boolean
}

export function Select({
  value, onChange, options, placeholder,
  className = '', variant = 'default', disabled = false
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [flipUp, setFlipUp] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayLabel = selectedOption?.label ?? placeholder ?? ''

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  const openDropdown = useCallback(() => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      const estimatedHeight = options.length * 32 + 8
      setFlipUp(spaceBelow < estimatedHeight)
    }
    setOpen(true)
    const idx = options.findIndex(o => o.value === value)
    setHighlightedIndex(idx >= 0 ? idx : 0)
  }, [disabled, options, value])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openDropdown()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(prev => {
          let next = prev + 1
          while (next < options.length && options[next].disabled) next++
          return next < options.length ? next : prev
        })
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(prev => {
          let next = prev - 1
          while (next >= 0 && options[next].disabled) next--
          return next >= 0 ? next : prev
        })
        break
      case 'Enter':
        e.preventDefault()
        if (highlightedIndex >= 0 && !options[highlightedIndex]?.disabled) {
          onChange(options[highlightedIndex].value)
          setOpen(false)
          triggerRef.current?.focus()
        }
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  // Scroll highlighted into view
  useEffect(() => {
    if (!open || highlightedIndex < 0) return
    const el = listRef.current?.children[highlightedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, open])

  const isInline = variant === 'inline'

  return (
    <div ref={containerRef} className={`relative ${className}`} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => open ? setOpen(false) : openDropdown()}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center gap-1.5 w-full text-left text-text-primary transition-colors
          focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
          ${isInline
            ? 'bg-transparent text-xs p-0 cursor-pointer'
            : 'bg-surface-primary border border-border-primary text-sm px-2.5 py-1.5 rounded-lg focus:border-text-muted'
          }`}
      >
        <span className={`flex-1 truncate ${!selectedOption ? 'text-text-muted' : ''}`}>
          {displayLabel}
        </span>
        <svg
          className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={`absolute z-50 min-w-full
            bg-surface-primary border border-border-primary rounded-lg shadow-lg py-1
            ${flipUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          {options.map((opt, i) => (
            <div
              key={opt.value + i}
              role="option"
              aria-selected={opt.value === value}
              onClick={() => {
                if (opt.disabled) return
                onChange(opt.value)
                setOpen(false)
                triggerRef.current?.focus()
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
              className={`px-2.5 py-1.5 text-sm cursor-pointer transition-colors truncate whitespace-nowrap
                ${opt.disabled ? 'text-text-muted cursor-not-allowed opacity-50' : ''}
                ${i === highlightedIndex ? 'bg-surface-hover' : ''}
                ${opt.value === value && !opt.disabled ? 'text-interactive font-medium' : 'text-text-primary'}
              `}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
