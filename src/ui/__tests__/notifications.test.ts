import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We test the notification helpers by mocking browser globals in Node.js.

let notifModule: typeof import('../lib/notifications')

function mockNotificationAPI(permission: string, requestResult = 'granted'): void {
  const instances: Array<{ title: string; options: Record<string, unknown>; onclick: (() => void) | null; close: () => void }> = []

  class MockNotification {
    title: string
    options: Record<string, unknown>
    onclick: (() => void) | null = null
    close = vi.fn()

    constructor(title: string, options: Record<string, unknown> = {}) {
      this.title = title
      this.options = options
      instances.push(this as unknown as typeof instances[0])
    }

    static permission = permission
    static requestPermission = vi.fn().mockResolvedValue(requestResult)
  }

  Object.defineProperty(globalThis, 'window', {
    value: { focus: vi.fn(), Notification: MockNotification },
    writable: true,
    configurable: true
  })
  Object.defineProperty(globalThis, 'Notification', {
    value: MockNotification,
    writable: true,
    configurable: true
  })

  // Expose instances for assertions
  ;(globalThis as Record<string, unknown>).__notifInstances = instances
}

function clearNotificationAPI(): void {
  delete (globalThis as Record<string, unknown>).Notification
  delete (globalThis as Record<string, unknown>).__notifInstances
  // Restore window to undefined-like (Node.js default)
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    writable: true,
    configurable: true
  })
}

describe('notifications', () => {
  beforeEach(async () => {
    // Fresh import each test to pick up global mocks
    vi.resetModules()
  })

  afterEach(() => {
    clearNotificationAPI()
  })

  describe('isSupported', () => {
    it('returns false when Notification API is absent', async () => {
      clearNotificationAPI()
      notifModule = await import('../lib/notifications')
      expect(notifModule.isSupported()).toBe(false)
    })

    it('returns true when Notification API is present', async () => {
      mockNotificationAPI('default')
      notifModule = await import('../lib/notifications')
      expect(notifModule.isSupported()).toBe(true)
    })
  })

  describe('isPermitted', () => {
    it('returns false when permission is not granted', async () => {
      mockNotificationAPI('default')
      notifModule = await import('../lib/notifications')
      expect(notifModule.isPermitted()).toBe(false)
    })

    it('returns true when permission is granted', async () => {
      mockNotificationAPI('granted')
      notifModule = await import('../lib/notifications')
      expect(notifModule.isPermitted()).toBe(true)
    })

    it('returns false when Notification API is absent', async () => {
      clearNotificationAPI()
      notifModule = await import('../lib/notifications')
      expect(notifModule.isPermitted()).toBe(false)
    })
  })

  describe('requestPermission', () => {
    it('returns true when user grants', async () => {
      mockNotificationAPI('default', 'granted')
      notifModule = await import('../lib/notifications')
      const result = await notifModule.requestPermission()
      expect(result).toBe(true)
      expect(Notification.requestPermission).toHaveBeenCalled()
    })

    it('returns false when user denies', async () => {
      mockNotificationAPI('default', 'denied')
      notifModule = await import('../lib/notifications')
      const result = await notifModule.requestPermission()
      expect(result).toBe(false)
    })

    it('returns false when Notification API is absent', async () => {
      clearNotificationAPI()
      notifModule = await import('../lib/notifications')
      const result = await notifModule.requestPermission()
      expect(result).toBe(false)
    })
  })

  describe('show', () => {
    it('creates Notification with title, body, and icon', async () => {
      mockNotificationAPI('granted')
      notifModule = await import('../lib/notifications')

      notifModule.show('Test Title', 'Test body')

      const instances = (globalThis as Record<string, unknown>).__notifInstances as Array<{
        title: string; options: Record<string, unknown>
      }>
      expect(instances).toHaveLength(1)
      expect(instances[0].title).toBe('Test Title')
      expect(instances[0].options.body).toBe('Test body')
      expect(instances[0].options.icon).toBe('/icon-192.png')
    })

    it('does not create Notification when permission is not granted', async () => {
      mockNotificationAPI('denied')
      notifModule = await import('../lib/notifications')

      notifModule.show('Title', 'Body')

      const instances = (globalThis as Record<string, unknown>).__notifInstances as unknown[]
      expect(instances).toHaveLength(0)
    })

    it('calls onClick callback and closes on click', async () => {
      mockNotificationAPI('granted')
      notifModule = await import('../lib/notifications')

      const onClick = vi.fn()
      notifModule.show('Title', 'Body', onClick)

      const instances = (globalThis as Record<string, unknown>).__notifInstances as Array<{
        onclick: (() => void) | null; close: ReturnType<typeof vi.fn>
      }>
      expect(instances).toHaveLength(1)

      // Simulate click
      instances[0].onclick?.()
      expect(onClick).toHaveBeenCalled()
      expect(instances[0].close).toHaveBeenCalled()
      expect(window.focus).toHaveBeenCalled()
    })
  })
})
