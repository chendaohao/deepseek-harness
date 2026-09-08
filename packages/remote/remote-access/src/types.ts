/**
 * Client-safe type vocabulary of the remote-access capability: the device
 * record shape and the cordis event it emits. Client-safe: nothing here
 * reaches a Host-only symbol, so a Client compilation face reads the same
 * `remote/devices/change` signature the Host emits.
 * @module @deepseek-ai/dsh-remote-access/types
 */

/** One paired device bound to a minted cookie. */
export interface DeviceRecord {
  deviceId: string
  name: string
  createdAt: number
  lastSeen: number
}

/** One paired device as presented on the control plane and the event bus. */
export type DeviceView = DeviceRecord & {
  /** Epoch time the device's 30-day inactivity window ends; daily use slides it forward. */
  expiresAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The device roster changed: a device paired, was revoked, or its liveness advanced.
     * @mode emit
     * @param devices - the live roster view after the change, each record carrying its window expiry.
     */
    'remote/devices/change'(devices: DeviceView[]): void
  }
}
