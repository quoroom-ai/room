interface UpdateModalProps {
  version: string
  currentVersion: string
  releaseUrl: string
  onDownload: () => void
  onSkip: () => void
  onDismiss: () => void
}

export function UpdateModal({
  version,
  currentVersion,
  releaseUrl,
  onDownload,
  onSkip,
  onDismiss,
}: UpdateModalProps): React.JSX.Element {
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
          <p className="text-xs font-semibold text-status-success uppercase tracking-wide mb-1">Update Available</p>
          <h2 className="text-xl font-bold text-text-primary mb-1">Quoroom v{version}</h2>
          <p className="text-sm text-text-muted mb-5">You're running v{currentVersion}.</p>

          <button
            onClick={() => { onDownload(); onDismiss() }}
            className="block w-full py-3 text-sm font-medium text-center text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors mb-3"
          >
            Download Update
          </button>

          <div className="flex items-center justify-between">
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover no-underline transition-colors"
            >
              Release notes
            </a>
            <button
              onClick={onSkip}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              Skip this version
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
