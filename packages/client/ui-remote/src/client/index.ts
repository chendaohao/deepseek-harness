/**
 * Desktop mobile-remote-control plugin, browser half: registers the settings
 * section that carries the remote-control panel — tunnel status badge, pairing
 * QR, device roster with revocation, and the stop-all action. Data rides the
 * remote-access control plane (`/remote/*` HTTP routes) plus the forwarded
 * `remote/devices/change` and `remote-tunnel/state` events this plugin
 * subscribes to while the section is mounted.
 * Export discipline: packages/client/AGENTS.md — no cross-plugin value
 * imports; `ctx.remote`, `ctx.slots`, and `ctx.locale` are injected peers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `remote` service merge and the forwarded-event
// vocabulary into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale (and the common namespace) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `settings.section` slot declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `slots` service merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { de, en, es, fr, ja, pt, ru, zh, type RemoteKey } from './locales.ts'
import { RemoteSettingsSection } from './RemoteSettingsSection.tsx'
import type { RemoteDeviceRecord, RemoteTunnelState } from './remote-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The device roster changed: a device paired, was revoked, or its liveness advanced.
     * @mode emit
     * @param devices - the full roster after the change.
     */
    'remote/devices/change'(devices: RemoteDeviceRecord[]): void
    /**
     * One tunnel session reported a durable fact: open, ended, or failed.
     * @mode emit
     * @param state - the tunnel state after the change.
     */
    'remote-tunnel/state'(state: RemoteTunnelState): void
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop remote-control panel copy. */
    remote: RemoteKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'remote'

export type {
  RemoteDeviceRecord, RemotePairResponse, RemoteStateResponse, RemoteTunnelState,
} from './remote-types.ts'
export type { RemoteSettingsSectionInjected, RemoteSettingsSectionProps } from './RemoteSettingsSection.tsx'
export type { RemotePanelProps } from './RemotePanel.tsx'
export type { RemoteKey } from './locales.ts'

/** Required services: the slot registry, the locale runtime, and the remote client. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the `remote` dictionaries and the remote-control settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-remote: dictionaries')
  const remote = ctx.remote
  // Registration-time nav text shares one bound translate with the inject face;
  // copy freshness rides the locale revision, which re-registers the section.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote',
    order: 25,
    locale: NS,
    label: () => t('nav'),
    inject: () => ({ remote }),
  }, RemoteSettingsSection))
}
