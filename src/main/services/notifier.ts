import type { Notifier } from "@opennib/core"

export interface SystemNotification {
  show(): void
}

export interface SystemNotificationOptions {
  readonly title: string
  readonly body: string
  readonly silent?: boolean
}

export interface SystemNotificationFactory {
  (options: SystemNotificationOptions): SystemNotification
}

/**
 * Notifier on desktop is a thin wrapper around Electron's Notification class.
 * The factory is injected so tests can substitute a stub without mocking the
 * electron module.
 */
export class ElectronNotifier implements Notifier {
  constructor(private readonly create: SystemNotificationFactory) {}

  async notify(title: string, body: string): Promise<void> {
    this.create({ title, body, silent: false }).show()
  }
}
