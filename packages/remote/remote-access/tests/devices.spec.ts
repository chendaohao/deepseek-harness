import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintCookie, type DeviceId } from '../src/secret.ts'
import { DEVICE_INACTIVITY_MS, DeviceRegistry, labelOf } from '../src/devices.ts'

const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)

let root: string | undefined
const registries: DeviceRegistry[] = []

// The write-failure arm mocks rename; everything else runs the real fs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-devices-'))
  registries.length = 0
})

afterEach(async () => {
  vi.mocked(rename).mockRestore()
  vi.mocked(unlink).mockRestore()
  for (const registry of registries) await registry.flush()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const devicesPath = (): string => join(root!, 'remote-devices.json')

async function loaded(options: { reset?: boolean; now?: () => number } = {}): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.load(devicesPath(), { now: () => NOW, ...options })
  registries.push(registry)
  return registry
}

/** Bind one freshly minted device and return its id. */
async function bindOne(registry: DeviceRegistry, label: string, at: number): Promise<DeviceId> {
  const { deviceId } = mintCookie(Buffer.alloc(32))
  registry.bind(deviceId, label, at)
  return deviceId
}

/** Await every created registry's pending durable writes. */
async function settleWrites(): Promise<void> {
  for (const registry of registries) await registry.flush()
}

describe('labels', () => {
  it('prefers the explicit name, then the User-Agent, then the default', () => {
    expect(labelOf('Pixel 8', 'UA')).toBe('Pixel 8')
    expect(labelOf(undefined, 'Mozilla/5.0 (Macintosh)')).toBe('Mozilla/5.0 (Macintosh)')
    expect(labelOf('  ', '')).toBe('未知设备')
  })

  it('strips control characters, collapses whitespace, and caps lengths', () => {
    expect(labelOf('a' + String.fromCharCode(3) + 'b   c', undefined)).toBe('a b c')
    expect(labelOf('x'.repeat(100), undefined)).toHaveLength(64)
    expect(labelOf(undefined, 'u'.repeat(300))).toHaveLength(120)
    // Characters beyond the C1 range (CJK and friends) survive untouched.
    expect(labelOf('中文 设备', undefined)).toBe('中文 设备')
  })
})

describe('persistence', () => {
  it('starts empty without a file and persists bindings atomically', async () => {
    const registry = await loaded()
    expect(registry.list()).toEqual([])
    const deviceId = await bindOne(registry, 'Phone', NOW)
    await settleWrites()
    const file = JSON.parse(await readFile(devicesPath(), 'utf8')) as { version: number; devices: { deviceId: string }[] }
    expect(file.version).toBe(1)
    expect(file.devices.map(device => device.deviceId)).toEqual([deviceId])
  })

  it('round-trips records through a reload', async () => {
    const first = await loaded()
    await bindOne(first, 'Phone', NOW)
    await bindOne(first, 'Tablet', NOW + 1_000)
    await settleWrites()
    const second = await loaded()
    const labels = second.list().map(device => device.label)
    expect(labels).toEqual(['Tablet', 'Phone'])
  })

  it('rethrows a non-ENOENT read failure at load', async () => {
    await mkdir(devicesPath())
    await expect(loaded()).rejects.toThrow(/EISDIR/)
  })

  it('refuses a file that is not valid JSON', async () => {
    await writeFile(devicesPath(), '{not json')
    await expect(loaded()).rejects.toThrow(/not valid JSON/)
  })

  it('refuses a file whose root or entries have the wrong shape', async () => {
    await writeFile(devicesPath(), JSON.stringify('just a string'))
    await expect(loaded()).rejects.toThrow(/unexpected structure/)
    await writeFile(devicesPath(), JSON.stringify({ version: 1, devices: [7] }))
    await expect(loaded()).rejects.toThrow(/unexpected structure/)
  })

  it('loads with every option defaulted', async () => {
    const registry = await DeviceRegistry.load(devicesPath())
    registries.push(registry)
    expect(registry.list()).toEqual([])
  })

  it('rethrows a non-ENOENT unlink failure during reset', async () => {
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(loaded({ reset: true })).rejects.toThrow(/permission denied/)
  })

  it('refuses a structurally wrong file', async () => {
    await writeFile(devicesPath(), JSON.stringify({ version: 1, devices: [{ deviceId: 'x', label: 7 }] }))
    await expect(loaded()).rejects.toThrow(/unexpected structure/)
  })

  it('discards the file on reset before loading', async () => {
    const first = await loaded()
    await bindOne(first, 'Phone', NOW)
    await settleWrites()
    const reset = await loaded({ reset: true })
    expect(reset.list()).toEqual([])
  })

  it('reports write failures through the injected sink and keeps serving', async () => {
    const onError = vi.fn()
    const registry = await DeviceRegistry.load(devicesPath(), { now: () => NOW, onWriteError: onError })
    registries.push(registry)
    const renameMock = vi.mocked(rename)
    renameMock.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    const deviceId = await bindOne(registry, 'Phone', NOW)
    await registry.flush()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
    // The in-memory truth survives the failed write and a later write lands.
    expect(registry.list().map(device => device.deviceId)).toEqual([deviceId])
    registry.unbind(deviceId)
    await registry.flush()
    const file = JSON.parse(await readFile(devicesPath(), 'utf8')) as { devices: unknown[] }
    expect(file.devices).toEqual([])
  })
})

describe('sliding window', () => {
  it('touches slide lastUsedAt and throttle persists once per UTC day', async () => {
    let now = NOW
    const registry = await loaded({ now: () => now })
    const deviceId = await bindOne(registry, 'Phone', now)
    expect(registry.touch(deviceId, now)).toEqual({ admitted: true, dayRolled: false })
    now = NOW + DAY_MS
    expect(registry.touch(deviceId, now)).toEqual({ admitted: true, dayRolled: true })
    expect(registry.touch(deviceId, now + 1_000)).toEqual({ admitted: true, dayRolled: false })
    const listed = registry.list()
    expect(listed[0]!.lastUsedAt).toBe(now + 1_000)
  })

  it('unbinds a device idle past the window and reports it', async () => {
    let now = NOW
    const registry = await loaded({ now: () => now })
    const deviceId = await bindOne(registry, 'Phone', now)
    now = NOW + DEVICE_INACTIVITY_MS - 1
    expect(registry.touch(deviceId, now).admitted).toBe(true)
    // A full window idle since that touch expires exactly at the deadline.
    now = now + DEVICE_INACTIVITY_MS
    expect(registry.touch(deviceId, now)).toEqual({ admitted: false, dayRolled: false })
    expect(registry.touch(deviceId, now)).toEqual({ admitted: false, dayRolled: false })
    expect(registry.list()).toEqual([])
  })

  it('an unknown device id is not admitted', async () => {
    const registry = await loaded()
    const { deviceId } = mintCookie(Buffer.alloc(32))
    expect(registry.touch(deviceId, NOW)).toEqual({ admitted: false, dayRolled: false })
  })

  it('list lazily drops expired devices and orders by recent use', async () => {
    let now = NOW
    const registry = await loaded({ now: () => now })
    const stale = await bindOne(registry, 'Stale', now)
    const fresh = await bindOne(registry, 'Fresh', now)
    registry.touch(fresh, NOW + DAY_MS)
    // One millisecond inside fresh's slid deadline: stale drops, fresh stays.
    now = NOW + DEVICE_INACTIVITY_MS + DAY_MS - 1
    const listed = registry.list()
    expect(listed.map(device => device.deviceId)).toEqual([fresh])
    expect(registry.touch(stale, now).admitted).toBe(false)
  })
})

describe('unbind and clear', () => {
  it('unbind removes exactly the named device', async () => {
    const registry = await loaded()
    const kept = await bindOne(registry, 'Kept', NOW)
    const removed = await bindOne(registry, 'Removed', NOW)
    expect(registry.unbind(removed)).toBe(true)
    expect(registry.unbind(removed)).toBe(false)
    expect(registry.list().map(device => device.deviceId)).toEqual([kept])
  })

  it('clear drops every binding (secret rotation)', async () => {
    const registry = await loaded()
    await bindOne(registry, 'A', NOW)
    await bindOne(registry, 'B', NOW)
    registry.clear()
    expect(registry.list()).toEqual([])
    await settleWrites()
    const file = JSON.parse(await readFile(devicesPath(), 'utf8')) as { devices: unknown[] }
    expect(file.devices).toEqual([])
  })
})
