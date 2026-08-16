/** Bound-device management page of the remote-access capability, registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.remote merge and the remoteAccessDevices namespace
// face into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteSection, type RemoteSectionInjected } from './RemoteSection.tsx'
import { en, zh, type RemoteLocaleKey } from './locales.ts'

export type { RemoteSectionCopyKey, RemoteSectionInjected, RemoteSectionProps } from './RemoteSection.tsx'
export type { RemoteLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Bound-device management copy of the Remote Access settings page. */
    'settings.remote': RemoteLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.remote'

/** Services required by the Settings registration and the generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.remoteAccessDevices']

/**
 * Contribute the Remote Access page once the `settings.section` declaration
 * is on the ledger (the settings shell owns the declaration).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-remote: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: RemoteSectionInjected['list'] = async () => {
    const result = await ctx.remote.remoteAccessDevices.list()
    if (!result.ok) {
      throw new Error('remoteAccessDevices.list failed: ' + result.error.code + ': ' + result.error.message)
    }
    return result.value.devices
  }
  const unbind: RemoteSectionInjected['unbind'] = async (deviceId) => {
    const result = await ctx.remote.remoteAccessDevices.unbind(deviceId)
    if (!result.ok) {
      throw new Error('remoteAccessDevices.unbind failed: ' + result.error.code + ': ' + result.error.message)
    }
    return result.value.removed
  }
  const injected = (): RemoteSectionInjected => ({ list, unbind, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, RemoteSection))
}
