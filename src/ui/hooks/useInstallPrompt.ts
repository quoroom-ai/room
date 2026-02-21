import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallPrompt {
  canInstall: boolean
  isInstalled: boolean
  isManualInstallPlatform: boolean
  install: () => Promise<boolean>
}

export function useInstallPrompt(): InstallPrompt {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(false)
  const [isManualInstallPlatform, setIsManualInstallPlatform] = useState(false)

  useEffect(() => {
    const ua = window.navigator.userAgent.toLowerCase()
    const isiOS = /iphone|ipad|ipod/.test(ua)
    const isSafari = ua.includes('safari') && !ua.includes('crios') && !ua.includes('fxios') && !ua.includes('edgios')

    // Already running as installed PWA
    const inStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (inStandalone) {
      setIsInstalled(true)
      setIsManualInstallPlatform(false)
      return
    }
    setIsManualInstallPlatform(isiOS && isSafari)

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    const onInstalled = () => {
      setIsInstalled(true)
      setDeferredPrompt(null)
    }

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function install(): Promise<boolean> {
    if (!deferredPrompt) return false
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    setDeferredPrompt(null)
    return outcome === 'accepted'
  }

  return { canInstall: !!deferredPrompt, isInstalled, isManualInstallPlatform, install }
}
