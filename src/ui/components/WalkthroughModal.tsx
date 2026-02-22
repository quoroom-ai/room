import { useState } from 'react'
import { APP_MODE } from '../lib/auth'
import { storageSet } from '../lib/storage'

const isCloud = APP_MODE === 'cloud'

const steps = [
  {
    title: 'You are the Keeper',
    body: 'Your room is a swarm of AI agents. A Queen is created automatically when you start — pick her brain in Settings: Claude, Codex, OpenAI, or a free local model via Ollama.',
  },
  {
    title: 'The Queen leads',
    body: "The Queen strategizes, plans, and assigns work. She's the most powerful agent in the room. Choose her model wisely — smarter models give better results but may cost more.",
  },
  {
    title: 'Workers multiply',
    body: isCloud
      ? "The Queen spawns workers as needed. They share your server's resources, so more workers means more load. Workers can use the Queen's model or run on a separate free Ollama model."
      : "The Queen spawns workers as needed. They share your machine resources, so more workers means more load. Workers can use the Queen's model or run on a separate free Ollama model.",
  },
  {
    title: 'Need more power? Rent stations',
    body: isCloud
      ? 'Stations add extra compute to your room — workers go to stations while the Queen stays on your server.'
      : 'Workers can run on rented cloud stations with free Ollama models. This offloads compute from your machine — the Queen stays local, workers go remote.',
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
      storageSet('quoroom_walkthrough_seen', '1')
      onClose()
    } else {
      setStep(step + 1)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8">
        <div className="flex gap-1.5 mb-6">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                i === step ? 'bg-interactive' : 'bg-surface-tertiary hover:bg-border-primary'
              }`}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        <h2 className="text-2xl font-bold text-text-primary mb-3 leading-tight">
          {steps[step].title}
        </h2>
        <p className="text-text-muted text-base leading-relaxed mb-8">
          {steps[step].body}
        </p>

        <div className="flex justify-end gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="px-4 py-2 text-sm text-text-muted hover:text-text-secondary border border-border-primary rounded-lg transition-colors"
            >
              Back
            </button>
          )}
          <button
            onClick={handleNext}
            className="px-5 py-2 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
          >
            {isLast ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
