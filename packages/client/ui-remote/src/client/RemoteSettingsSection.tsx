/**
 * Remote-control settings section: the same panel the sidebar foot used to open
 * in a dialog, rendered as a Settings page instead — tunnel status badge, one-
 * time pairing QR, device roster with per-device rename and revocation, and the
 * stop-all action. The page owns no state of its own; it binds the injected
 * remote client into {@link RemotePanel}.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemotePanel } from './RemotePanel.tsx'
import css from './RemoteSettingsSection.module.css'

/** Entry-injected share the section receives from this plugin's apply. */
export interface RemoteSettingsSectionInjected {
  /** Host-connection remote client handed to the panel for event subscriptions. */
  remote: ClientRemote
}

/** Full component props: the settings section seat, the injected remote client, and the locale seat. */
export type RemoteSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<RemoteSettingsSectionInjected>
  & PropsLocale<'settings.remote'>

/**
 * Render the remote-control settings page.
 * @param props - {@link RemoteSettingsSectionProps}.
 * @returns the section element tree.
 */
export function RemoteSettingsSection({ t, remote }: RemoteSettingsSectionProps) {
  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('nav')}</h2>
      <p className={css.intro}>{t('panel.subtitle')}</p>
      <RemotePanel remote={remote} t={t} />
    </div>
  )
}
