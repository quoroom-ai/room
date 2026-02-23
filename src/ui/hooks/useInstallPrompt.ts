import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallPrompt {
  canInstall: boolean
  isInstalled: boolean
  isManualInstallPlatform: boolean
  installSignal: number
  install: () => Promise<boolean>
}

export function useInstallPrompt(): InstallPrompt {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(false)
  const [isManualInstallPlatform, setIsManualInstallPlatform] = useState(false)
  const [installSignal, setInstallSignal] = useState(0)

  useEffect(() => {
    const ua = window.navigator.userAgent.toLowerCase()
    const isSafari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('crios') && !ua.includes('fxios') && !ua.includes('edgios')

    // Already running as installed PWA
    const inStandalone = window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (inStandalone) {
      setIsInstalled(true)
      setIsManualInstallPlatform(false)
      return
    }
    // In dev mode, SW is unregistered so beforeinstallprompt never fires — pretend manual install
    setIsManualInstallPlatform(isSafari || import.meta.env.DEV)

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    const onInstalled = () => {
      setIsInstalled(true)
      setDeferredPrompt(null)
      setInstallSignal((prev) => prev + 1)
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
    if (outcome === 'accepted') {
      setInstallSignal((prev) => prev + 1)
    }
    return outcome === 'accepted'
  }

  return { canInstall: !!deferredPrompt, isInstalled, isManualInstallPlatform, installSignal, install }
}
