/** Completion-notification preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this package's completion notifier. */
export const NOTIFY_SETTINGS_NAMESPACE = 'ui-session'

/** Durable section shared by the Host schema and the browser scope. */
export interface NotifySettings {
  /** Whether a system notification fires when a Session stops running while the document is hidden. */
  completionNotifications?: boolean
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const NotifySettingsFields = {
  completionNotifications: z.boolean().default(false),
}
