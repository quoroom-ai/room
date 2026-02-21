export interface OllamaModelOption {
  value: string
  label: string
}

const FREE_OLLAMA_MODEL_DEFS = [
  { id: 'llama3.2', label: 'Llama 3.2' },
  { id: 'qwen3:14b', label: 'Qwen3 14B' },
  { id: 'deepseek-r1:14b', label: 'DeepSeek R1 14B' },
  { id: 'gemma3:12b', label: 'Gemma 3 12B' },
  { id: 'phi4', label: 'Phi-4' },
] as const

const LEGACY_OLLAMA_MODEL_IDS = ['llama3'] as const

export const FREE_OLLAMA_MODEL_OPTIONS: OllamaModelOption[] = FREE_OLLAMA_MODEL_DEFS.map((model) => ({
  value: `ollama:${model.id}`,
  label: model.label,
}))

export const FREE_OLLAMA_MODEL_VALUES = new Set<string>([
  ...FREE_OLLAMA_MODEL_OPTIONS.map((model) => model.value),
  ...FREE_OLLAMA_MODEL_DEFS.map((model) => model.id),
  ...LEGACY_OLLAMA_MODEL_IDS.map((model) => `ollama:${model}`),
  ...LEGACY_OLLAMA_MODEL_IDS,
])

export function stripOllamaPrefix(model: string): string {
  const trimmed = model.trim()
  return trimmed.startsWith('ollama:') ? trimmed.slice('ollama:'.length) : trimmed
}

export function isSupportedFreeOllamaModel(model: string): boolean {
  const trimmed = model.trim()
  if (!trimmed) return false
  return FREE_OLLAMA_MODEL_VALUES.has(trimmed)
}
