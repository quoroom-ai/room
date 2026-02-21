import { useState, useEffect } from 'react'

interface AnalogClockProps {
  size?: number
}

export function AnalogClock({ size = 160 }: AnalogClockProps): React.JSX.Element {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = time.getSeconds()
  const minutes = time.getMinutes()
  const hours = time.getHours() % 12

  const secondDeg = seconds * 6
  const minuteDeg = minutes * 6 + seconds * 0.1
  const hourDeg = hours * 30 + minutes * 0.5

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 200" width={size} height={size}>
        <circle cx="100" cy="100" r="95" fill="var(--surface-primary)" stroke="var(--border-primary)" strokeWidth="2" />
        {Array.from({ length: 60 }).map((_, i) => {
          const isHour = i % 5 === 0
          const angle = (i * 6 - 90) * (Math.PI / 180)
          const inner = isHour ? 80 : 85
          const x1 = 100 + inner * Math.cos(angle)
          const y1 = 100 + inner * Math.sin(angle)
          const x2 = 100 + 90 * Math.cos(angle)
          const y2 = 100 + 90 * Math.sin(angle)
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={isHour ? 'var(--text-muted)' : 'var(--border-primary)'}
              strokeWidth={isHour ? 2 : 1}
              strokeLinecap="round"
            />
          )
        })}
        <line x1="100" y1="100" x2="100" y2="45" stroke="var(--text-primary)" strokeWidth="4" strokeLinecap="round" transform={`rotate(${hourDeg} 100 100)`} />
        <line x1="100" y1="100" x2="100" y2="25" stroke="var(--text-primary)" strokeWidth="2.5" strokeLinecap="round" transform={`rotate(${minuteDeg} 100 100)`} />
        <line x1="100" y1="110" x2="100" y2="20" stroke="var(--status-error)" strokeWidth="1" strokeLinecap="round" transform={`rotate(${secondDeg} 100 100)`} />
        <circle cx="100" cy="100" r="4" fill="var(--text-primary)" />
        <circle cx="100" cy="100" r="2" fill="var(--status-error)" />
      </svg>
      <div className="mt-3 text-center">
        <div className="text-sm font-mono text-text-secondary">
          {time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </div>
        <div className="text-xs text-text-muted mt-0.5">
          {time.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        </div>
      </div>
    </div>
  )
}
