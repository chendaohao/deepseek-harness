/** Host registration for Session completion-notification preferences. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { NotifySettings } from './notify-settings.ts'

import { NotifySettingsFields } from './notify-settings.ts'

export { NOTIFY_SETTINGS_NAMESPACE, type NotifySettings } from './notify-settings.ts'

/** Live preferences projected to the browser. */
export interface Config {
  /** Whether a system notification fires when a Session stops running in a hidden document. */
  completionNotifications: Volatile<NotifySettings['completionNotifications']>
}

/** Live preference schema registered under the settings namespace. */
export const Config = z.object({
  completionNotifications: NotifySettingsFields.completionNotifications.volatile(),
})

/**
 * Registers the completion-notification preference namespace.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
