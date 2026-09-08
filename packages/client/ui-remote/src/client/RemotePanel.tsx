/**
 * Desktop remote-control panel: tunnel status badge, pairing QR, device
 * roster with per-device revocation, and the stop-all action. State comes
 * from the remote-access control plane (`/remote/*` HTTP routes) plus the
 * forwarded `remote/devices/change` and `remote-tunnel/state` events while
 * the panel is open. Mounted only while the owning footer trigger's modal is
 * open, so the fetch + subscriptions live exactly the dialog's lifetime.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  RemoteDeviceRecord, RemotePairResponse, RemoteStateResponse,
} from './remote-types.ts'
import css from './RemotePanel.module.css'

/** Tunnel view unified from the `/remote/state` snapshot and the live events. */
type TunnelView =
  | { status: 'open'; url: string }
  | { status: 'down' }
  | { status: 'failed'; message: string }

/** Milliseconds without a liveness touch before a device reads offline. */
const DEVICE_ONLINE_WINDOW_MS = 5 * 60_000

/** Whether a device record's liveness is within the online window. */
function isOnline(record: RemoteDeviceRecord): boolean {
  return Date.now() - record.lastSeen < DEVICE_ONLINE_WINDOW_MS
}

/** Whole days until the device's inactivity window ends, floored at zero. */
function expiryDaysLeft(record: RemoteDeviceRecord): number {
  return Math.max(0, Math.floor((record.expiresAt - Date.now()) / 86_400_000))
}

/** The panel's injected props: the remote client plus the locale seat. */
export interface RemotePanelProps {
  /** Host-connection remote client for the forwarded-event subscriptions. */
  remote: ClientRemote
  /** The locale-bound translate seat of the `remote` namespace. */
  t: TranslateNS<'remote'>
}

/**
 * Render the remote-control dialog body.
 * @param props - {@link RemotePanelProps}.
 * @returns the panel body tree.
 */
export function RemotePanel({ remote, t }: RemotePanelProps) {
  const [tunnel, setTunnel] = useState<TunnelView>({ status: 'down' })
  const [devices, setDevices] = useState<RemoteDeviceRecord[]>([])
  const [pairUrl, setPairUrl] = useState<string | null>(null)
  const [pairBusy, setPairBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const aliveRef = useRef(true)

  /** Mint a fresh one-time pairing URL from the control plane. */
  const refreshPair = useCallback(async (): Promise<void> => {
    setPairBusy(true)
    try {
      const res = await fetch('/remote/pair/issue', { method: 'POST' })
      if (!res.ok) throw new Error(`remote/pair/issue: HTTP ${res.status}`)
      const data = await res.json() as RemotePairResponse
      if (!aliveRef.current) return
      setPairUrl(data.url)
      setError(null)
    } catch {
      if (aliveRef.current) setError(t('pair.unavailable'))
    } finally {
      if (aliveRef.current) setPairBusy(false)
    }
  }, [t])

  useEffect(() => {
    aliveRef.current = true
    void fetch('/remote/state').then(async (res) => {
      if (!res.ok) throw new Error(`remote/state: HTTP ${res.status}`)
      const data = await res.json() as RemoteStateResponse
      if (!aliveRef.current) return
      if (data.tunnelStatus === 'open' && data.tunnelUrl !== null) {
        setTunnel({ status: 'open', url: data.tunnelUrl })
        void refreshPair()
      } else {
        setTunnel({ status: 'down' })
      }
      setDevices(data.devices)
    }).catch(() => { if (aliveRef.current) setError(t('load.error')) })
    const offDevices = remote.$on('remote/devices/change', (next) => {
      if (aliveRef.current) setDevices(next)
    })
    const offTunnel = remote.$on('remote-tunnel/state', (state) => {
      if (!aliveRef.current) return
      if (state.status === 'open') setTunnel({ status: 'open', url: state.url })
      else if (state.status === 'ended') setTunnel({ status: 'down' })
      else setTunnel({ status: 'failed', message: state.message })
    })
    return () => {
      aliveRef.current = false
      offDevices()
      offTunnel()
    }
  }, [remote, refreshPair, t])

  const copyLink = useCallback(async (): Promise<void> => {
    if (pairUrl === null) return
    if (await writeClipboard(pairUrl)) {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1200)
    }
  }, [pairUrl])

  const stopRemote = useCallback(async (): Promise<void> => {
    setConfirmingStop(false)
    try {
      const res = await fetch('/remote/stop', { method: 'POST' })
      if (!res.ok) throw new Error(`remote/stop: HTTP ${res.status}`)
    } catch {
      if (aliveRef.current) setError(t('load.error'))
    }
  }, [t])

  const revokeDevice = useCallback(async (deviceId: string): Promise<void> => {
    try {
      const res = await fetch(`/remote/devices/${encodeURIComponent(deviceId)}/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error(`remote/devices/revoke: HTTP ${res.status}`)
    } catch {
      if (aliveRef.current) setError(t('load.error'))
    }
  }, [t])

  const startRename = useCallback((device: RemoteDeviceRecord): void => {
    setRenamingId(device.deviceId)
    setDraftName(device.name)
  }, [])

  const cancelRename = useCallback((): void => {
    setRenamingId(null)
    setDraftName('')
  }, [])

  const saveRename = useCallback(async (): Promise<void> => {
    const deviceId = renamingId
    const name = draftName.trim()
    if (deviceId === null || name === '') return
    try {
      const res = await fetch(`/remote/devices/${encodeURIComponent(deviceId)}/rename?name=${encodeURIComponent(name)}`, { method: 'POST' })
      if (!res.ok) throw new Error(`remote/devices/rename: HTTP ${res.status}`)
      if (aliveRef.current) {
        setRenamingId(null)
        setDraftName('')
        setError(null)
      }
    } catch {
      if (aliveRef.current) setError(t('device.renameError'))
    }
  }, [renamingId, draftName, t])

  return (
    <div className={css.panel}>
      <div className={css.statusRow}>
        <span className={tunnel.status === 'open' ? css.badgeOpen : tunnel.status === 'failed' ? css.badgeFailed : css.badgeDown}>
          {tunnel.status === 'open' ? t('tunnel.open') : tunnel.status === 'failed' ? t('tunnel.failed') : t('tunnel.down')}
        </span>
      </div>

      {error !== null && <p className={css.error} role="alert">{error}</p>}

      <section className={css.qrSection}>
        <h3 className={css.sectionTitle}>{t('scan.label')}</h3>
        {pairUrl !== null ? (
          <QRCodeSVG value={pairUrl} title={pairUrl} size={200} className={css.qr} />
        ) : (
          <div className={css.qrPlaceholder}>
            {tunnel.status === 'open' ? t('loading') : t('pair.unavailable')}
          </div>
        )}
        <div className={css.qrActions}>
          <button
            type="button"
            className={css.actionButton}
            disabled={pairBusy || tunnel.status !== 'open'}
            onClick={() => { void refreshPair() }}
          >
            {t('refreshQr')}
          </button>
          <button
            type="button"
            className={css.actionButton}
            disabled={pairUrl === null}
            onClick={() => { void copyLink() }}
          >
            {copied ? t('copied') : t('copyLink')}
          </button>
        </div>
      </section>

      <section className={css.devicesSection}>
        <h3 className={css.sectionTitle}>{t('devices.title')}</h3>
        {devices.length === 0 ? (
          <p className={css.devicesEmpty}>{t('devices.empty')}</p>
        ) : (
          <ul className={css.deviceList}>
            {devices.map(device => (
              <li key={device.deviceId} className={css.deviceRow}>
                {renamingId === device.deviceId ? (
                  <>
                    <input
                      type="text"
                      className={css.renameInput}
                      value={draftName}
                      maxLength={40}
                      autoFocus
                      onChange={(event) => { setDraftName(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void saveRename() }
                        if (event.key === 'Escape') cancelRename()
                      }}
                    />
                    <button
                      type="button"
                      className={css.actionButton}
                      disabled={draftName.trim() === ''}
                      onClick={() => { void saveRename() }}
                    >
                      {t('device.renameSave')}
                    </button>
                    <button type="button" className={css.actionButton} onClick={cancelRename}>
                      {t('device.renameCancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <span className={css.deviceName}>{device.name}</span>
                    <button
                      type="button"
                      className={css.renameButton}
                      onClick={() => { startRename(device) }}
                    >
                      {t('device.rename')}
                    </button>
                    <span className={css.deviceStatus}>
                      {isOnline(device) ? t('device.online') : t('device.offline')}
                      {' · '}
                      {t('device.expiry', { days: expiryDaysLeft(device) })}
                    </span>
                  </>
                )}
                <button
                  type="button"
                  className={css.revokeButton}
                  onClick={() => { void revokeDevice(device.deviceId) }}
                >
                  {t('device.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={css.stopRow}>
        {confirmingStop ? (
          <>
            <span className={css.stopConfirm}>{t('stop.confirm')}</span>
            <button type="button" className={css.stopButton} onClick={() => { void stopRemote() }}>
              {t('stop.confirmAction')}
            </button>
            <button type="button" className={css.actionButton} onClick={() => { setConfirmingStop(false) }}>
              {t('cancel')}
            </button>
          </>
        ) : (
          <button type="button" className={css.stopButton} onClick={() => { setConfirmingStop(true) }}>
            {t('stop')}
          </button>
        )}
      </div>
    </div>
  )
}
