/**
 * The Remote Access settings page: the bound-device list of the remote-access
 * pairing gate. Pure props presentation — the list and unbind wire calls
 * arrive through the inject face; loaded rows and the two-step unbind
 * confirmation are component-local state (nothing here outlives the page).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { RemoteDeviceView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RemoteSection.module.css'

/** One UTC day in milliseconds; the auto-unbind window counts these. */
const DAY_MS = 86_400_000

/** The wire face the page consumes (composed by the plugin's inject). */
export interface RemoteSectionInjected {
  /** Live bound devices, newest use first. */
  readonly list: () => Promise<readonly RemoteDeviceView[]>
  /** Unbind one device; resolves false when it was already gone. */
  readonly unbind: (deviceId: RemoteDeviceView['deviceId']) => Promise<boolean>
  /** Page copy. */
  readonly t: (key: RemoteSectionCopyKey, vars?: Record<string, string>) => string
}

/** Copy keys the page itself renders. */
export type RemoteSectionCopyKey =
  | 'intro' | 'empty' | 'loadFailed' | 'retry' | 'boundOn'
  | 'lastUsedJustNow' | 'lastUsedMinutesAgo' | 'lastUsedHoursAgo' | 'lastUsedDaysAgo'
  | 'expiresInDays' | 'expiresToday'
  | 'unbind' | 'confirmUnbind' | 'cancel' | 'unbindFailed'

/** Props delivered by the slot outlet: the inject face spread flat. */
export type RemoteSectionProps = Partial<RemoteSectionInjected>

/**
 * Render the bound-device page (nothing until the inject face is complete).
 * @param props - the inject face (list, unbind, t).
 * @returns the section element tree.
 */
export function RemoteSection(props: RemoteSectionProps): ReactNode {
  const { list, unbind, t } = props
  if (list === undefined || unbind === undefined || t === undefined) return null
  return <Loaded key="remote-devices" list={list} unbind={unbind} t={t} />
}

/** The loaded page against the complete face. */
function Loaded({ list, unbind, t }: RemoteSectionInjected): ReactNode {
  const [devices, setDevices] = useState<readonly RemoteDeviceView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [unbinding, setUnbinding] = useState(false)

  const reload = useCallback(() => {
    setFailed(false)
    void list().then((rows) => { setDevices(rows) }, () => { setFailed(true) })
  }, [list])

  useEffect(() => { reload() }, [reload])

  const confirmUnbind = (deviceId: RemoteDeviceView['deviceId']): void => {
    setUnbinding(true)
    void unbind(deviceId).then((removed) => {
      setUnbinding(false)
      setConfirmingId(null)
      if (removed) reload()
      else setFailed(true)
    }, () => {
      setUnbinding(false)
      setFailed(true)
    })
  }

  return (
    <section className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      {devices === null && !failed ? <p className={css.empty}>…</p> : null}
      {devices !== null && devices.length === 0 && !failed
        ? <p className={css.empty}>{t('empty')}</p>
        : null}
      {devices !== null && devices.length > 0
        ? (
          <ul className={css.list}>
            {devices.map(device => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                t={t}
                confirming={confirmingId === device.deviceId}
                unbinding={unbinding}
                onAskUnbind={() => { setConfirmingId(device.deviceId) }}
                onCancel={() => { setConfirmingId(null) }}
                onConfirm={() => { confirmUnbind(device.deviceId) }}
              />
            ))}
          </ul>
        )
        : null}
      {failed
        ? (
          <p className={css.error} role="alert">
            {t('loadFailed')}
            {' '}
            <Button variant="ghost" size="sm" onClick={reload}>{t('retry')}</Button>
          </p>
        )
        : null}
    </section>
  )
}

/** One bound-device row with its two-step unbind action. */
function DeviceRow(props: {
  device: RemoteDeviceView
  t: RemoteSectionInjected['t']
  confirming: boolean
  unbinding: boolean
  readonly onAskUnbind: () => void
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactNode {
  const { device, t, confirming, unbinding } = props
  const now = Date.now()
  const daysLeft = Math.max(0, Math.ceil((device.expiresAt - now) / DAY_MS))
  return (
    <li className={css.row}>
      <div className={css.identity}>
        <span className={css.label}>{device.label}</span>
        <span className={css.meta}>
          <span>{t('boundOn', { date: new Date(device.boundAt).toLocaleDateString() })}</span>
          <span aria-hidden="true"> · </span>
          <span>{lastUsedOf(device.lastUsedAt, now, t)}</span>
          <span aria-hidden="true"> · </span>
          <span>{daysLeft <= 0 ? t('expiresToday') : t('expiresInDays', { n: String(daysLeft) })}</span>
        </span>
      </div>
      {confirming
        ? (
          <div className={css.actions}>
            <Button variant="ghost" size="sm" disabled={unbinding} onClick={props.onCancel}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={unbinding} onClick={props.onConfirm}>
              {t('confirmUnbind')}
            </Button>
          </div>
        )
        : (
          <div className={css.actions}>
            <Button variant="ghost" size="sm" onClick={props.onAskUnbind}>
              {t('unbind')}
            </Button>
          </div>
        )}
    </li>
  )
}

/** The localized last-use phrase of one device. */
function lastUsedOf(
  lastUsedAt: number,
  now: number,
  t: RemoteSectionInjected['t'],
): string {
  const minutes = Math.floor((now - lastUsedAt) / 60_000)
  if (minutes < 1) return t('lastUsedJustNow')
  if (minutes < 60) return t('lastUsedMinutesAgo', { n: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('lastUsedHoursAgo', { n: String(hours) })
  return t('lastUsedDaysAgo', { n: String(Math.floor(hours / 24)) })
}
