/**
 * Sidebar footer action for remote control: a phone-glyph trigger that opens
 * the desktop remote-control modal. Registered into `sidebar.footer.action`
 * beside Settings; the owner passes only the column state, so the rail icon
 * matches the settings trigger geometry.
 */
import { useState } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { RemotePanel } from './RemotePanel.tsx'
import css from './RemoteFooterAction.module.css'

/** A mobile-phone glyph (figma mobile-device outline). */
function PhoneIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="4" y="1.5" width="8" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="6.5" y="11.25" width="3" height="1" rx="0.5" fill="currentColor" />
    </svg>
  )
}

/** Entry-injected share the footer action receives from this plugin's apply. */
export interface RemoteFooterActionInjected {
  /** Host-connection remote client handed to the panel for event subscriptions. */
  remote: ClientRemote
}

/** Full component props: the sidebar column state plus the injected remote client and the locale seat. */
export type RemoteFooterActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & RemoteFooterActionInjected
  & PropsLocale<'remote'>

/**
 * Render the remote-control trigger and its modal.
 * @param props - {@link RemoteFooterActionProps}.
 * @returns the trigger row plus the (closed-by-default) modal.
 */
export function RemoteFooterAction({ wide, t, remote }: RemoteFooterActionProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label={t('footerAction')} side="right" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={wide ? css.trigger : css.rail}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(true) }}
        >
          <PhoneIcon size={wide ? 14 : 18} />
          {wide && <span className={css.label}>{t('footerAction')}</span>}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('panel.title')}
        description={t('panel.subtitle')}
        closeLabel={t('close')}
      >
        <RemotePanel remote={remote} t={t} />
      </Modal>
    </>
  )
}
