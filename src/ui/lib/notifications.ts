export function isSupported(): boolean {
  return 'Notification' in window
}

export function isPermitted(): boolean {
  return isSupported() && Notification.permission === 'granted'
}

export async function requestPermission(): Promise<boolean> {
  if (!isSupported()) return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

let badgeCount = 0

export function show(title: string, body: string, onClick?: () => void): void {
  if (!isPermitted()) return
  const n = new Notification(title, {
    body,
    icon: '/icon-192.png',
  })
  n.onclick = () => {
    window.focus()
    n.close()
    onClick?.()
  }
  setBadge(++badgeCount)
}

/** Set app badge count on Dock icon (PWA). */
export function setBadge(count: number): void {
  badgeCount = count
  if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
    if (count > 0) {
      (navigator as any).setAppBadge(count).catch(() => {})
    } else {
      (navigator as any).clearAppBadge().catch(() => {})
    }
  }
}

/** Clear badge when user focuses the app. */
export function clearBadge(): void {
  setBadge(0)
}
