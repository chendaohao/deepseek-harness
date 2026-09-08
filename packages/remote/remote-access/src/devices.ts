/**
 * Device and pairing-token store of the remote-access capability: the one-time
 * pairing token and the revocable device registry behind the proxy gate.
 * @module @deepseek-ai/dsh-remote-access/devices
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dayIndex } from './secret.ts'
import type { DeviceRecord, DeviceView } from './types.ts'

/** Milliseconds a pairing token stays valid after issuance. */
export const TOKEN_TTL_MS = 15 * 60_000
/** Inactivity window after which a device binding auto-unbinds. */
export const DEVICE_INACTIVITY_MS = 30 * 86_400_000
/** Device-id length in bytes; base64url output is dot-free so it splits cleanly inside a cookie. */
const DEVICE_ID_BYTES = 16
/** Minimum seconds between liveness-change notifications per device. */
const TOUCH_NOTIFY_MIN_SECONDS = 5

/** One admission touch's outcome. */
export interface TouchResult {
  /** Whether the device is admitted: the binding exists and is inside the inactivity window. */
  readonly admitted: boolean
  /** The touch crossed a UTC day boundary: the gate re-issues the cookie's Max-Age now. */
  readonly dayRolled: boolean
}

/** One-time pairing tokens plus the persistent, revocable device roster. */
export class DeviceRegistry {
  private readonly tokens = new Map<string, number>()
  private readonly devices = new Map<string, DeviceRecord>()
  /**
   * Fired on any roster change. The boolean is true for a structural change
   * (register/revoke/revokeAll — worth persisting) and false for a liveness
   * touch. The owner wires the event bus and persistence.
   */
  onChange: ((structural: boolean) => void) | undefined

  /** @param path - optional persistence path; undefined keeps the registry in memory only. */
  constructor(private readonly path: string | undefined) {}

  /** Load persisted devices, treating a missing file as an empty roster. */
  async load(): Promise<void> {
    if (this.path === undefined) return
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('remote-access: device registry ' + JSON.stringify(this.path) + ' must be a JSON array')
    }
    for (const record of parsed as Array<DeviceRecord | null>) {
      if (record === null || typeof record.deviceId !== 'string' || typeof record.name !== 'string') {
        throw new Error('remote-access: device registry ' + JSON.stringify(this.path) + ' holds a malformed record')
      }
      this.devices.set(record.deviceId, record)
    }
  }

  /** Atomically persist the roster (tmp + rename, mode 0600 under a 0700 directory). */
  async persist(): Promise<void> {
    if (this.path === undefined) return
    const dir = dirname(this.path)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    await writeFile(tmp, JSON.stringify([...this.devices.values()]), { mode: 0o600 })
    await rename(tmp, this.path)
  }

  /**
   * Mint a one-time pairing token; a fresh issuance invalidates the previous one.
   * @param now - the current epoch time in milliseconds.
   * @returns the minted token.
   */
  issueToken(now: number): string {
    const token = randomBytes(32).toString('base64url')
    this.tokens.clear()
    this.tokens.set(token, now + TOKEN_TTL_MS)
    return token
  }

  /**
   * Consume a one-time pairing token; expires the entry on success and on expiry alike.
   * @param token - the token to consume.
   * @param now - the current epoch time in milliseconds.
   * @returns true when the token was valid and consumed.
   */
  consumeToken(token: string, now: number): boolean {
    const expiresAt = this.tokens.get(token)
    if (expiresAt === undefined || now >= expiresAt) return false
    this.tokens.delete(token)
    return true
  }

  /**
   * Register a paired device and return its new id.
   * @param name - the user-supplied device label.
   * @param now - the current epoch time in milliseconds.
   * @returns the new device id.
   */
  register(name: string, now: number): string {
    const deviceId = randomBytes(DEVICE_ID_BYTES).toString('base64url')
    this.devices.set(deviceId, { deviceId, name, createdAt: now, lastSeen: now })
    this.onChange?.(true)
    return deviceId
  }

  /**
   * Rename one device (a user-assigned label); returns whether it was paired.
   * @param deviceId - the device to rename.
   * @param name - the new label.
   * @returns true when the device was paired and renamed.
   */
  rename(deviceId: string, name: string): boolean {
    const record = this.devices.get(deviceId)
    if (record === undefined) return false
    record.name = name
    this.onChange?.(true)
    return true
  }

  /**
   * Whether a device id is currently paired.
   * @param deviceId - the device id to check.
   * @returns true when the device is paired.
   */
  isLive(deviceId: string): boolean {
    return this.devices.has(deviceId)
  }

  /**
   * Refresh a device's last-seen time, sliding its 30-day inactivity window;
   * a device idle past the window is unbound and denied. Notifies at most
   * once per interval, and reports UTC day rollover so the gate can refresh
   * the browser cookie's Max-Age on the response.
   * @param deviceId - the device to touch.
   * @param now - the current epoch time in milliseconds.
   * @returns the admission verdict and whether the UTC day rolled over.
   */
  touch(deviceId: string, now: number): TouchResult {
    const record = this.devices.get(deviceId)
    if (record === undefined) return { admitted: false, dayRolled: false }
    if (now - record.lastSeen >= DEVICE_INACTIVITY_MS) {
      this.devices.delete(deviceId)
      this.onChange?.(true)
      return { admitted: false, dayRolled: false }
    }
    const dayRolled = dayIndex(now) > dayIndex(record.lastSeen)
    if (now - record.lastSeen < TOUCH_NOTIFY_MIN_SECONDS * 1000 && !dayRolled) {
      return { admitted: true, dayRolled }
    }
    record.lastSeen = now
    this.onChange?.(false)
    return { admitted: true, dayRolled }
  }

  /**
   * Revoke one device; returns whether it was paired.
   * @param deviceId - the device to revoke.
   * @returns true when the device was paired and revoked.
   */
  revoke(deviceId: string): boolean {
    const removed = this.devices.delete(deviceId)
    if (removed) this.onChange?.(true)
    return removed
  }

  /** Revoke every paired device (pairing reset). */
  revokeAll(): void {
    if (this.devices.size === 0) return
    this.devices.clear()
    this.onChange?.(true)
  }

  /**
   * Snapshot of the live roster, newest first.
   * @returns the live device records.
   */
  snapshot(): DeviceRecord[] {
    return [...this.devices.values()].reverse()
  }

  /**
   * Snapshot of the live roster, newest first, each record carrying the
   * epoch time its inactivity window ends (lastSeen + 30 days).
   * @returns the live device views with their expiry instants.
   */
  snapshotWithExpiry(): DeviceView[] {
    return this.snapshot().map(record => ({ ...record, expiresAt: record.lastSeen + DEVICE_INACTIVITY_MS }))
  }
}
