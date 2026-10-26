/** General Settings row for Session completion notifications. */
import { useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './NotifyRow.module.css'

/** Accepted preference and ordered mutation supplied by the settings owner. */
export interface NotifyRowInjected {
  hooks: {
    /** Current preference, bound as useCompletionNotifications. */
    completionNotifications: ObservableSnapshot<boolean>
  }
  /** Enable or disable completion notifications; resolves after the write settles. */
  setCompletionNotifications(enabled: boolean): Promise<void>
  /** Live notification permission: granted, denied, prompt, or unsupported absence. */
  permission(): NotificationPermission | undefined
  /** Ask the browser for notification permission.
   * @returns the resolved permission, or absence on unsupported platforms. */
  requestPermission(): Promise<NotificationPermission | undefined>
}

/** Full Settings-row props. */
export type NotifyRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'sessionNotify'>
  & InjectFace<NotifyRowInjected>

/**
 * Render the completion-notification toggle and its permission hint.
 * @param props - preference hooks, writer, permission state, and localized copy.
 * @returns the General Settings row.
 */
export function NotifyRow({
  useCompletionNotifications, setCompletionNotifications, permission, requestPermission, t,
}: NotifyRowProps) {
  const enabled = useCompletionNotifications(value => value)
  const [current, setCurrent] = useState<NotificationPermission | undefined>(permission)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const refreshPermission = async (): Promise<NotificationPermission | undefined> => {
    const resolved = await requestPermission()
    setCurrent(resolved)
    return resolved
  }
  const hint = current === undefined
    ? t('notify.unsupported')
    : current === 'denied'
      ? t('notify.denied')
      : undefined
  return <div className={css.row}>
    <div>
      <div className={css.title}>{t('settings.notify.title')}</div>
      <div className={css.description}>{t('settings.notify.description')}</div>
      {hint !== undefined && <div className={css.description} role="alert">{hint}</div>}
      {failed && <div className={css.description} role="alert">{t('settings.notify.error')}</div>}
    </div>
    <Switch
      checked={enabled}
      disabled={busy || current === 'denied' || current === undefined}
      label={t('settings.notify.title')}
      onChange={(next) => {
        setFailed(false)
        setBusy(true)
        void (async () => {
          try {
            if (next && permission() !== 'granted') {
              const resolved = await refreshPermission()
              if (resolved !== 'granted') return
            }
            await setCompletionNotifications(next)
          } catch {
            setFailed(true)
          } finally {
            setBusy(false)
          }
        })()
      }}
    />
  </div>
}
