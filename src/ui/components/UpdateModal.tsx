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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 relative">
        {/* Close */}
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 text-gray-300 hover:text-gray-500 text-lg leading-none transition-colors"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Content */}
        <div className="pr-4">
          <p className="text-xs font-semibold text-green-600 uppercase tracking-wide mb-1">Update Available</p>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Quoroom v{version}</h2>
          <p className="text-sm text-gray-400 mb-5">You're running v{currentVersion}.</p>

          {/* Download button */}
          <button
            onClick={() => { onDownload(); onDismiss() }}
            className="block w-full py-2.5 text-sm font-medium text-center text-white bg-gray-800 hover:bg-gray-900 rounded-lg transition-colors mb-3"
          >
            Download Update
          </button>

          {/* Footer links */}
          <div className="flex items-center justify-between">
            <a
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              Release notes
            </a>
            <button
              onClick={onSkip}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Skip this version
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
