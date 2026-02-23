import { useMemo } from 'react'

interface KeepInDockModalProps {
  onDismiss: () => void
}

type Platform = 'macos' | 'windows' | 'linux' | 'other'

interface PlatformCopy {
  heading: string
  steps: string[]
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('win')) return 'windows'
  if (ua.includes('linux')) return 'linux'
  return 'other'
}

function getPlatformCopy(platform: Platform): PlatformCopy {
  if (platform === 'macos') {
    return {
      heading: 'Keep Quoroom in your Dock',
      steps: [
        'Open Quoroom.',
        'Right-click the Quoroom icon in the Dock.',
        'Select Options, then Keep in Dock.',
      ],
    }
  }

  if (platform === 'windows') {
    return {
      heading: 'Pin Quoroom to your taskbar',
      steps: [
        'Open Quoroom.',
        'Right-click the Quoroom icon on the taskbar.',
        'Select Pin to taskbar.',
      ],
    }
  }

  if (platform === 'linux') {
    return {
      heading: 'Pin Quoroom to your launcher',
      steps: [
        'Open Quoroom.',
        'Right-click the Quoroom icon in your dock or app launcher.',
        'Select Pin to Favorites (or equivalent in your desktop environment).',
      ],
    }
  }

  return {
    heading: 'Pin Quoroom for quick access',
    steps: [
      'Open Quoroom.',
      'Use your system app menu or dock context menu.',
      'Choose the option to pin, keep in dock, or pin to taskbar.',
    ],
  }
}

export function KeepInDockModal({ onDismiss }: KeepInDockModalProps): React.JSX.Element {
  const copy = useMemo(() => getPlatformCopy(detectPlatform()), [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 relative">
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
          aria-label="Close"
        >
          {'\u2715'}
        </button>

        <div className="pr-4">
          <p className="text-xs font-semibold text-status-success uppercase tracking-wide mb-1">Installed</p>
          <h2 className="text-xl font-bold text-text-primary mb-2">{copy.heading}</h2>
          <ol className="list-decimal list-inside text-sm text-text-secondary space-y-1 mb-5">
            {copy.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <button
            onClick={onDismiss}
            className="block w-full py-3 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
