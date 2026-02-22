/**
 * Safe localStorage helpers.
 * All calls are wrapped in try/catch so that blocked storage
 * (private browsing, restrictive extensions, iframe sandboxing)
 * never throws and crashes React.
 */

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore — storage blocked.
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore — storage blocked.
  }
}
