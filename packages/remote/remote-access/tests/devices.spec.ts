import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry, TOKEN_TTL_MS } from '../src/devices.ts'

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)
let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-devices-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const devicesPath = (): string => join(root!, 'secrets', 'remote-devices.json')

describe('one-time pairing tokens', () => {
  it('issues a URL-safe token and consumes it exactly once', () => {
    const registry = new DeviceRegistry(undefined)
    const token = registry.issueToken(NOW)
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,60}$/)
    expect(registry.consumeToken(token, NOW)).toBe(true)
    expect(registry.consumeToken(token, NOW + 1)).toBe(false)
  })

  it('expires a token at the end of its TTL', () => {
    const registry = new DeviceRegistry(undefined)
    const token = registry.issueToken(NOW)
    expect(registry.consumeToken(token, NOW + TOKEN_TTL_MS - 1)).toBe(true)
    const again = registry.issueToken(NOW)
    expect(registry.consumeToken(again, NOW + TOKEN_TTL_MS)).toBe(false)
  })

  it('rejects an unknown or expired token', () => {
    const registry = new DeviceRegistry(undefined)
    expect(registry.consumeToken('nope', NOW)).toBe(false)
    const token = registry.issueToken(NOW)
    expect(registry.consumeToken(token, NOW + TOKEN_TTL_MS + 1)).toBe(false)
  })

  it('a fresh issuance invalidates the previous token', () => {
    const registry = new DeviceRegistry(undefined)
    const first = registry.issueToken(NOW)
    const second = registry.issueToken(NOW)
    expect(first).not.toBe(second)
    expect(registry.consumeToken(first, NOW)).toBe(false)
    expect(registry.consumeToken(second, NOW)).toBe(true)
  })
})

describe('device roster', () => {
  it('registers a live device and revokes it', () => {
    const registry = new DeviceRegistry(undefined)
    expect(registry.snapshot()).toEqual([])
    const deviceId = registry.register('mobile', NOW)
    expect(registry.isLive(deviceId)).toBe(true)
    expect(registry.snapshot()).toMatchObject([{ deviceId, name: 'mobile', createdAt: NOW, lastSeen: NOW }])
    expect(registry.revoke(deviceId)).toBe(true)
    expect(registry.isLive(deviceId)).toBe(false)
    expect(registry.snapshot()).toEqual([])
    expect(registry.revoke(deviceId)).toBe(false)
  })

  it('revokeAll clears every device', () => {
    const registry = new DeviceRegistry(undefined)
    registry.register('a', NOW)
    registry.register('b', NOW)
    registry.revokeAll()
    expect(registry.snapshot()).toEqual([])
  })

  it('renames a paired device structurally and ignores an unknown id', () => {
    const registry = new DeviceRegistry(undefined)
    const changes: boolean[] = []
    registry.onChange = (structural) => { changes.push(structural) }
    const deviceId = registry.register('mobile', NOW)
    expect(registry.rename(deviceId, '我的iPhone')).toBe(true)
    expect(registry.snapshot()[0]?.name).toBe('我的iPhone')
    expect(changes).toEqual([true, true]) // register + rename are both structural
    expect(registry.rename('no-such-device', 'x')).toBe(false)
    expect(registry.snapshot()).toHaveLength(1)
  })

  it('touch advances lastSeen but only notifies once per interval', () => {
    const registry = new DeviceRegistry(undefined)
    const changes: boolean[] = []
    registry.onChange = (structural) => { changes.push(structural) }
    const deviceId = registry.register('mobile', NOW)
    expect(changes).toEqual([true])
    registry.touch(deviceId, NOW + 1_000)
    expect(changes).toHaveLength(1) // below the notify interval
    registry.touch(deviceId, NOW + 6_000)
    expect(changes).toHaveLength(2)
    expect(changes[1]).toBe(false)
    expect(registry.snapshot()[0]?.lastSeen).toBe(NOW + 6_000)
  })

  it('ignores touch on an unknown or revoked device', () => {
    const registry = new DeviceRegistry(undefined)
    const deviceId = registry.register('mobile', NOW)
    registry.revoke(deviceId)
    registry.touch(deviceId, NOW + 6_000)
    expect(registry.snapshot()).toEqual([])
  })
})

describe('persistence', () => {
  it('persists and reloads the roster', async () => {
    const registry = new DeviceRegistry(devicesPath())
    const deviceId = registry.register('mobile', NOW)
    await registry.persist()
    expect((await stat(devicesPath())).mode & 0o777).toBe(0o600)
    const reloaded = new DeviceRegistry(devicesPath())
    await reloaded.load()
    expect(reloaded.snapshot()).toMatchObject([{ deviceId, name: 'mobile', createdAt: NOW, lastSeen: NOW }])
  })

  it('loads an absent file as an empty roster', async () => {
    const registry = new DeviceRegistry(devicesPath())
    await registry.load()
    expect(registry.snapshot()).toEqual([])
  })

  it('refuses a malformed registry file', async () => {
    await mkdir(join(root!, 'secrets'), { recursive: true })
    await writeFile(devicesPath(), 'not-json')
    const registry = new DeviceRegistry(devicesPath())
    await expect(registry.load()).rejects.toThrow()
  })

  it('refuses a non-array registry file', async () => {
    await mkdir(join(root!, 'secrets'), { recursive: true })
    await writeFile(devicesPath(), '{"deviceId":"x"}')
    const registry = new DeviceRegistry(devicesPath())
    await expect(registry.load()).rejects.toThrow(/must be a JSON array/)
  })

  it('a memory-only registry persists nothing', async () => {
    const registry = new DeviceRegistry(undefined)
    registry.register('mobile', NOW)
    await registry.persist()
    expect(registry.snapshot()).toHaveLength(1)
  })

  it('persists via the structural onChange hook', async () => {
    const persist = vi.spyOn(DeviceRegistry.prototype, 'persist').mockResolvedValue(undefined)
    const registry = new DeviceRegistry(undefined)
    const changes: boolean[] = []
    registry.onChange = (structural) => { changes.push(structural) }
    registry.register('mobile', NOW)
    registry.revokeAll()
    expect(changes).toEqual([true, true])
    expect(persist).not.toHaveBeenCalled() // persistence is the owner's wiring, not the registry's
  })
})
