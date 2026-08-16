/**
 * Remote projection of the bound-device registry: the settings page's device
 * list and unbind. Registered as the typert Remote namespace
 * remoteAccessDevices; absent unless the remote-access plugin is enabled.
 * @module @deepseek-ai/dsh-remote-access/remote-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DEVICE_INACTIVITY_MS, type DeviceRecord, type DeviceRegistry } from './devices.ts'
import type { DeviceId } from './secret.ts'
import type { RemoteDeviceList } from './types.ts'

/** Construction options: the owning registry. */
export interface RemoteAccessGatewayConfig {
  readonly registry: DeviceRegistry
}

/** The remoteAccessDevices Remote service (ctx key of the same name). */
export class RemoteAccessGateway extends TypertRemoteService {
  private readonly registry: DeviceRegistry

  /**
   * @param ctx - owning Cordis Context (the remote-access fiber's).
   * @param config - the device registry.
   */
  constructor(ctx: Context, config: RemoteAccessGatewayConfig) {
    super(ctx, 'remoteAccessDevices')
    this.registry = config.registry
  }

  /**
   * List live bindings; expired ones drop out here (lazy expiry GC).
   * @returns devices ordered by most recent use.
   */
  @Remote('list')
  list(): RemoteDeviceList {
    return { devices: this.registry.list().map(viewOf) }
  }

  /**
   * Unbind one device; its next request answers 401 and re-pairs.
   * @param deviceId - the device to unbind.
   * @returns whether a binding existed and was removed.
   */
  @Remote('unbind')
  unbind(deviceId: DeviceId): { removed: boolean } {
    return { removed: this.registry.unbind(deviceId) }
  }
}

/** Project one registry record onto its wire view. */
function viewOf(record: DeviceRecord): RemoteDeviceList['devices'][number] {
  return {
    deviceId: record.deviceId,
    label: record.label,
    boundAt: record.boundAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.lastUsedAt + DEVICE_INACTIVITY_MS,
  }
}
