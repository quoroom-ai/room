import { useState } from 'react'

const steps = [
  {
    title: 'You are the Keeper',
    body: 'Your room is a swarm of AI agents. A Queen is created automatically when you start — she runs on Claude and coordinates everything from day one.',
  },
  {
    title: 'The Queen leads',
    body: "The Queen uses your Claude subscription to strategize, plan, and assign work. She's the most powerful agent in the room — and she stays in charge.",
  },
  {
    title: 'Workers multiply',
    body: 'The Queen spawns workers as needed. Create as many as you want — but remember, they share your Claude subscription and computer resources. More workers means more load.',
  },
  {
    title: 'Need more power? Rent stations',
    body: 'Workers can run on rented cloud stations using a free LLM model (Ollama). This offloads compute from your machine. The Queen stays on Claude, workers go remote.',
  },
  {
    title: 'Democracy in the swarm',
    body: "Every important decision is made by vote. Until there are workers, it's just you and the Queen — you both have a say. Add workers and they can outvote you. Use Auto or Semi mode to control what the swarm does.",
  },
  {
    title: "You're in charge",
    body: 'Check settings before starting the room. Chat with the Queen anytime and track all activity. Workers may ask for credentials to access outside services — you decide whether to help. Find this guide again in Help.',
  },
]

interface WalkthroughModalProps {
  onClose: () => void
}

export function WalkthroughModal({ onClose }: WalkthroughModalProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const isLast = step === steps.length - 1

  function handleNext() {
    if (isLast) {
      localStorage.setItem('quoroom_walkthrough_seen', '1')
      onClose()
    } else {
      setStep(step + 1)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8 relative">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-300 hover:text-gray-500 text-lg leading-none transition-colors"
          aria-label="Close"
        >
          ✕
        </button>

        {/* Dots */}
        <div className="flex gap-1.5 mb-6">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === step ? 'bg-amber-500' : 'bg-gray-200 hover:bg-gray-300'
              }`}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        {/* Content */}
        <h2 className="text-2xl font-bold text-gray-900 mb-3 leading-tight">
          {steps[step].title}
        </h2>
        <p className="text-gray-500 text-base leading-relaxed mb-8">
          {steps[step].body}
        </p>

        {/* Footer */}
        <div className="flex justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg transition-colors"
            >
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            className="px-5 py-2 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors"
          >
            {isLast ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
