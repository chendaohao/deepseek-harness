/**
 * Wire view types of the remoteAccessDevices Remote namespace — client-safe
 * (no Cordis imports) so the Client assembly re-exports them.
 * @module @deepseek-ai/dsh-remote-access/types
 */

import type { DeviceId } from './secret.ts'

/** Wire view of one bound device. */
export interface RemoteDeviceView {
  /** Device identity carried by the v2 session cookie. */
  readonly deviceId: DeviceId
  /** Display label captured at pairing. */
  readonly label: string
  /** Epoch milliseconds the pairing completed. */
  readonly boundAt: number
  /** Epoch milliseconds of the last admitted request. */
  readonly lastUsedAt: number
  /** lastUsedAt plus the inactivity window: the auto-unbind deadline. */
  readonly expiresAt: number
}

/** One device-list call's answer. */
export interface RemoteDeviceList {
  readonly devices: readonly RemoteDeviceView[]
}
