interface ServiceWorkerRegistrationLike {
  unregister: () => Promise<boolean>
}

interface ServiceWorkerContainerLike {
  getRegistrations: () => Promise<ServiceWorkerRegistrationLike[]>
}

interface NavigatorLike {
  serviceWorker?: ServiceWorkerContainerLike
}

interface CacheStorageLike {
  keys: () => Promise<string[]>
  delete: (cacheName: string) => Promise<boolean>
}

function getServiceWorkerContainer(): ServiceWorkerContainerLike | null {
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator
  if (!nav?.serviceWorker) return null
  return nav.serviceWorker
}

function getCacheStorage(): CacheStorageLike | null {
  const cacheStorage = (globalThis as { caches?: CacheStorageLike }).caches
  if (!cacheStorage) return null
  return cacheStorage
}

/**
 * Removes legacy PWA artifacts that can keep serving stale UI after upgrades.
 * Returns true if stale artifacts were detected and cleanup was attempted.
 */
export async function cleanupLegacyPwaArtifacts(): Promise<boolean> {
  let detectedLegacyArtifacts = false

  const sw = getServiceWorkerContainer()
  if (sw) {
    try {
      const registrations = await sw.getRegistrations()
      if (registrations.length > 0) detectedLegacyArtifacts = true
      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await registration.unregister()
          } catch {
            // Best-effort cleanup.
          }
        })
      )
    } catch {
      // Best-effort cleanup.
    }
  }

  const cacheStorage = getCacheStorage()
  if (cacheStorage) {
    try {
      const cacheKeys = await cacheStorage.keys()
      if (cacheKeys.length > 0) detectedLegacyArtifacts = true
      await Promise.all(
        cacheKeys.map(async (key) => {
          try {
            await cacheStorage.delete(key)
          } catch {
            // Best-effort cleanup.
          }
        })
      )
    } catch {
      // Best-effort cleanup.
    }
  }

  return detectedLegacyArtifacts
}
