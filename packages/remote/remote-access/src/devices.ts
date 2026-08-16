/**
 * The bound-device registry: the durable truth behind pairing. Each
 * successful pairing mints one device record; every admitted request touches
 * it (sliding the 30-day inactivity window), and an expired or explicitly
 * unbound record is removed. The registry file persists beside the pairing
 * secret under the harness home; a malformed file fails loud at load.
 * @module @deepseek-ai/dsh-remote-access/devices
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dayIndex, type DeviceId } from './secret.ts'

/** Inactivity window after which a binding auto-unbinds. */
export const DEVICE_INACTIVITY_MS = 30 * 86_400_000
/** Character cap for an explicit pairing name. */
const NAME_MAX = 64
/** Character cap for the User-Agent fallback label. */
const USER_AGENT_MAX = 120
/** Label when pairing carried neither a name nor a User-Agent. */
const DEFAULT_LABEL = '未知设备'

/** One persisted device binding. */
export interface DeviceRecord {
  /** Device identity carried by the v2 session cookie. */
  readonly deviceId: DeviceId
  /** Display label captured at pairing (explicit name or User-Agent prefix). */
  readonly label: string
  /** Epoch milliseconds the pairing completed. */
  readonly boundAt: number
  /** Epoch milliseconds of the last admitted request; the sliding window anchors here. */
  readonly lastUsedAt: number
}

/** One admission touch's outcome. */
export interface TouchResult {
  /** Whether the request is admitted (binding exists and is inside the window). */
  readonly admitted: boolean
  /** The touch crossed a UTC day boundary: persist and refresh the cookie now. */
  readonly dayRolled: boolean
}

/** Load-time options: reset discards the file first; now and the write-error sink are injectable. */
export interface DeviceLoadOptions {
  readonly reset?: boolean
  readonly now?: () => number
  readonly onWriteError?: (error: unknown) => void
}

/** On-disk shape: the record list only (version carried by the format below). */
interface DeviceFile {
  readonly version: 1
  readonly devices: readonly DeviceRecord[]
}

/**
 * Clean one pairing-label source: strip control characters, collapse
 * whitespace, cap the length.
 * @param raw - the raw name or User-Agent string, when present.
 * @param cap - maximum kept characters.
 * @returns the cleaned label, possibly empty.
 */
export function sanitizeLabel(raw: string | undefined, cap: number): string {
  if (raw === undefined) return ''
  let spaced = ''
  for (const character of raw) {
    /* v8 ignore next -- a code unit always carries a code point */
    const code = character.codePointAt(0) ?? 0x20
    spaced += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character
  }
  const collapsed = spaced.split(' ').filter(part => part !== '').join(' ')
  return collapsed.length > cap ? collapsed.slice(0, cap) : collapsed
}

/**
 * Resolve the label of a new binding: the explicit pairing name, else the
 * User-Agent prefix, else the default.
 * @param name - the pairing request's `?name=` parameter, when present.
 * @param userAgent - the pairing request's User-Agent header, when present.
 * @returns the bounded display label.
 */
export function labelOf(name: string | undefined, userAgent: string | undefined): string {
  return sanitizeLabel(name, NAME_MAX) || sanitizeLabel(userAgent, USER_AGENT_MAX) || DEFAULT_LABEL
}

/**
 * The in-memory device registry with day-throttled durable writes.
 */
export class DeviceRegistry {
  private readonly records = new Map<DeviceId, DeviceRecord>()
  /** UTC day index each device's record was last written for. */
  private readonly persistedDays = new Map<DeviceId, number>()
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(
    private readonly path: string,
    private readonly now: () => number,
    private readonly onWriteError: ((error: unknown) => void) | undefined,
  ) {}

  /**
   * Load the registry from its file, creating an empty one when absent.
   * @param path - registry file path (mode 0600 under a 0700 directory).
   * @param options - reset discards the file first; now and onWriteError are injectable.
   * @returns the loaded registry.
   */
  static async load(path: string, options: DeviceLoadOptions = {}): Promise<DeviceRegistry> {
    if (options.reset === true) await removeRegistryFile(path)
    const registry = new DeviceRegistry(path, options.now ?? Date.now, options.onWriteError)
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('remote-access: device registry ' + JSON.stringify(path) + ' is not valid JSON')
    }
    if (!isDeviceFile(parsed)) {
      throw new Error('remote-access: device registry ' + JSON.stringify(path) + ' has an unexpected structure')
    }
    for (const record of parsed.devices) {
      registry.records.set(record.deviceId, record)
      registry.persistedDays.set(record.deviceId, dayIndex(record.lastUsedAt))
    }
    return registry
  }

  /**
   * Register a freshly paired device and persist immediately.
   * @param deviceId - the minted device identity.
   * @param label - the resolved display label.
   * @param at - the pairing time in epoch milliseconds.
   */
  bind(deviceId: DeviceId, label: string, at: number): void {
    this.records.set(deviceId, { deviceId, label, boundAt: at, lastUsedAt: at })
    this.persistedDays.delete(deviceId)
    this.persistSoon(deviceId, at)
  }

  /**
   * Admit one request against the sliding window: absent or expired bindings
   * are removed (expired ones persisted) and rejected; live ones slide.
   * @param deviceId - the cookie's device identity.
   * @param at - the request time in epoch milliseconds.
   * @returns the admission verdict and whether the UTC day rolled over.
   */
  touch(deviceId: DeviceId, at: number): TouchResult {
    const record = this.records.get(deviceId)
    if (record === undefined) return { admitted: false, dayRolled: false }
    if (at - record.lastUsedAt >= DEVICE_INACTIVITY_MS) {
      this.records.delete(deviceId)
      this.persistedDays.delete(deviceId)
      this.persistSoon(deviceId, at)
      return { admitted: false, dayRolled: false }
    }
    const dayRolled = dayIndex(at) > dayIndex(record.lastUsedAt)
    this.records.set(deviceId, { ...record, lastUsedAt: at })
    if (dayRolled) this.persistSoon(deviceId, at)
    return { admitted: true, dayRolled }
  }

  /**
   * Remove one binding explicitly (the settings page's unbind).
   * @param deviceId - the device to unbind.
   * @returns whether a binding existed and was removed.
   */
  unbind(deviceId: DeviceId): boolean {
    const existed = this.records.delete(deviceId)
    this.persistedDays.delete(deviceId)
    if (existed) this.persistNow()
    return existed
  }

  /**
   * Drop every binding (secret rotation invalidates all cookies wholesale).
   */
  clear(): void {
    this.records.clear()
    this.persistedDays.clear()
    this.persistNow()
  }

  /**
   * List live bindings, dropping expired ones first (lazy expiry GC).
   * @returns records ordered by most recent use.
   */
  list(): DeviceRecord[] {
    const at = this.now()
    let dropped = false
    for (const [deviceId, record] of this.records) {
      if (at - record.lastUsedAt >= DEVICE_INACTIVITY_MS) {
        this.records.delete(deviceId)
        this.persistedDays.delete(deviceId)
        dropped = true
      }
    }
    if (dropped) this.persistNow()
    return [...this.records.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  /** Record the device's persisted day and schedule the durable write. */
  private persistSoon(deviceId: DeviceId, at: number): void {
    this.persistedDays.set(deviceId, dayIndex(at))
    this.persistNow()
  }

  /**
   * Await every queued durable write (tests and teardown use this to
   * observe quiescence before deleting state).
   */
  async flush(): Promise<void> {
    await this.writeChain
  }

  /** Serialize a write; failures report through the injected sink when present. */
  private persistNow(): void {
    this.writeChain = this.writeChain.then(() => this.write()).catch((error: unknown) => {
      this.onWriteError?.(error)
    })
  }

  /** One atomic write: temp file in the same directory, then rename. */
  private async write(): Promise<void> {
    const devices = [...this.records.values()].sort((a, b) => a.boundAt - b.boundAt)
    const file: DeviceFile = { version: 1, devices }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    await writeFile(tmp, JSON.stringify(file) + String.fromCharCode(10), { mode: 0o600 })
    await rename(tmp, this.path)
  }
}

/** Structural check of the parsed registry file. */
function isDeviceFile(value: unknown): value is DeviceFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as { version?: unknown; devices?: unknown }
  return file.version === 1 && Array.isArray(file.devices)
    && file.devices.every(isDeviceRecord)
}

/** Structural check of one parsed record. */
function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { deviceId?: unknown; label?: unknown; boundAt?: unknown; lastUsedAt?: unknown }
  return typeof record.deviceId === 'string' && record.deviceId !== ''
    && typeof record.label === 'string'
    && typeof record.boundAt === 'number' && Number.isFinite(record.boundAt)
    && typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt)
}

/** Remove a possibly link-shaped registry file without following links. */
async function removeRegistryFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
