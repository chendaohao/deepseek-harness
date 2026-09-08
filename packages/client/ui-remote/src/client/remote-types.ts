/**
 * Client-side payload vocabulary of the remote-access control plane. These
 * structural types mirror the host's `DeviceRecord` and `RemoteTunnelState`
 * declarations; the browser face declares them locally so `ctx.remote.$on`
 * listeners type-check without pulling host-only modules into the client
 * bundle (the wire values are already validated by the host).
 * @module @deepseek-ai/dsh-client-ui-remote/client
 */

/** One paired device bound to a minted cookie. */
export interface RemoteDeviceRecord {
  deviceId: string
  name: string
  createdAt: number
  lastSeen: number
  /** Epoch time the device's 30-day inactivity window ends; daily use slides it forward. */
  expiresAt: number
}

/** Terminal or reporting facts about one tunnel session, discriminated by status. */
export type RemoteTunnelState =
  | { status: 'open'; url: string }
  | { status: 'ended' }
  | { status: 'failed'; message: string }

/** `GET /remote/state` payload. */
export interface RemoteStateResponse {
  tunnelUrl: string | null
  tunnelStatus: 'open' | 'down'
  devices: RemoteDeviceRecord[]
}

/** `POST /remote/pair/issue` payload. */
export interface RemotePairResponse {
  url: string
}
