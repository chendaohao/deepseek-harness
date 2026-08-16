import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, mintCookie, pairingTicket } from '../src/secret.ts'
import { DEVICE_INACTIVITY_MS, DeviceRegistry } from '../src/devices.ts'
import { cookieValue, createAccessPolicy, type AccessPolicy } from '../src/policy.ts'

interface FakeRequest {
  method?: string
  // Wider than IncomingHttpHeaders on purpose: the policy must label an
  // array-shaped User-Agent, and the case below passes one.
  headers?: Record<string, string | string[] | undefined>
  remoteAddress?: string
  url?: string
}

function request(fields: FakeRequest): IncomingMessage {
  return {
    method: 'GET',
    headers: {},
    socket: { remoteAddress: fields.remoteAddress ?? '203.0.113.9' },
    ...fields,
  } as unknown as IncomingMessage
}

/** One response the policy answered, as the test observes it. */
interface RecordedResponse {
  status: number
  headers?: Record<string, string>
}

/** A response stub recording every writeHead call instead of touching the wire. */
function response(): { res: ServerResponse; calls: RecordedResponse[] } {
  const calls: RecordedResponse[] = []
  const res = {
    writeHead: (status: number, headers?: Record<string, string>): void => {
      calls.push({ status, ...(headers === undefined ? {} : { headers }) })
    },
    end: (): void => {},
  } as unknown as ServerResponse
  return { res, calls }
}

const secret = randomBytes(32)
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0)

let root: string | undefined
const registries: DeviceRegistry[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-policy-'))
  registries.length = 0
})

afterEach(async () => {
  for (const registry of registries) await registry.flush()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A fresh registry on the temp root with an injectable clock. */
async function registry(now: () => number): Promise<DeviceRegistry> {
  const loaded = await DeviceRegistry.load(join(root!, 'devices.json'), { now })
  registries.push(loaded)
  return loaded
}

/** The status one wrong-ticket pairing attempt receives from the policy. */
function failedPairingStatus(policy: AccessPolicy): number {
  const { res, calls } = response()
  policy.handlePairing(request({}), res, '/pair/AAAA')
  return calls[0]!.status
}

describe('authorize', () => {
  it('denies every host without a cookie: no loopback or Host shortcut exists', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW) })
    for (const host of ['127.0.0.1', '127.0.0.1:8080', '127.9.9.9', 'localhost', 'localhost:3080', '[::1]', '[::1]:3080', 'fake.tunnel.example', '']) {
      expect(policy.authorize(request({ headers: { host } })).admitted).toBe(false)
    }
    // A hostname merely starting with the loopback prefix is not loopback.
    expect(policy.authorize(request({ headers: { host: '127.0.0.1.evil.com' } })).admitted).toBe(false)
    expect(policy.authorize(request({ headers: { host: '127.0.0.1.attacker.io:8080' } })).admitted).toBe(false)
    expect(policy.authorize(request({ headers: { host: '127.evil.com' } })).admitted).toBe(false)
  })

  it('admits any host with a live device cookie; a tampered cookie fails', async () => {
    const devices = await registry(() => NOW)
    const { value, deviceId } = mintCookie(secret)
    devices.bind(deviceId, 'Test Phone', NOW)
    const policy = createAccessPolicy(secret, { devices, now: () => NOW })
    const cookie = COOKIE_NAME + '=' + value
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie } })).admitted).toBe(true)
    expect(policy.authorize(request({ headers: { host: '127.0.0.1', cookie } })).admitted).toBe(true)
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie: COOKIE_NAME + '=v2.x.y' } })).admitted).toBe(false)
    expect(policy.authorize(request({ headers: {} })).admitted).toBe(false)
  })

  it('denies a valid cookie whose binding was unbound', async () => {
    const devices = await registry(() => NOW)
    const { value, deviceId } = mintCookie(secret)
    devices.bind(deviceId, 'Gone', NOW)
    devices.unbind(deviceId)
    const policy = createAccessPolicy(secret, { devices, now: () => NOW })
    expect(policy.authorize(request({ headers: { cookie: COOKIE_NAME + '=' + value } })).admitted).toBe(false)
  })

  it('auto-unbinds after 30 idle days and slides while in use', async () => {
    let now = NOW
    const devices = await registry(() => now)
    const { value, deviceId } = mintCookie(secret)
    devices.bind(deviceId, 'Phone', now)
    const policy = createAccessPolicy(secret, { devices, now: () => now })
    const cookie = COOKIE_NAME + '=' + value
    // Day 29 of inactivity: still admitted, and the touch slides the window.
    now = NOW + (DEVICE_INACTIVITY_MS - 86_400_000)
    expect(policy.authorize(request({ headers: { cookie } })).admitted).toBe(true)
    // 29 more idle days from that touch: still inside the slid window.
    now = NOW + 2 * (DEVICE_INACTIVITY_MS - 86_400_000)
    expect(policy.authorize(request({ headers: { cookie } })).admitted).toBe(true)
    // A full window of idleness since the last touch: unbound, and stays so.
    now += DEVICE_INACTIVITY_MS
    expect(policy.authorize(request({ headers: { cookie } })).admitted).toBe(false)
    expect(policy.authorize(request({ headers: { cookie } })).admitted).toBe(false)
    expect(devices.list()).toEqual([])
  })

  it('echoes the cookie refresh on the first admitted request of a UTC day only', async () => {
    let now = NOW
    const devices = await registry(() => now)
    const { value, deviceId } = mintCookie(secret)
    devices.bind(deviceId, 'Phone', now)
    const policy = createAccessPolicy(secret, { devices, now: () => now })
    const cookie = COOKIE_NAME + '=' + value
    expect(policy.authorize(request({ headers: { cookie } }))).toEqual({ admitted: true })
    // Second request the same day: no refresh.
    expect(policy.authorize(request({ headers: { cookie } }))).toEqual({ admitted: true })
    now = NOW + 86_400_000
    expect(policy.authorize(request({ headers: { cookie } }))).toEqual({
      admitted: true,
      cookieRefresh: cookie + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + String(COOKIE_MAX_AGE_SECONDS),
    })
    expect(policy.authorize(request({ headers: { cookie } }))).toEqual({ admitted: true })
  })
})

describe('cookieValue', () => {
  it('finds the dsh_remote cookie among several', () => {
    expect(cookieValue('a=1; dsh_remote=v2.b.c; b=2')).toBe('v2.b.c')
    expect(cookieValue('dsh_remote=')).toBe('')
    expect(cookieValue('a=1; b=2')).toBeUndefined()
    expect(cookieValue(undefined)).toBeUndefined()
  })
})

describe('handlePairing', () => {
  it('falls through for non-pair paths', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW })
    expect(policy.handlePairing(request({}), response().res, '/api/x')).toBe(false)
    expect(policy.handlePairing(request({}), response().res, '/')).toBe(false)
  })

  it('pairs a valid current-day ticket: 302, location, and the hardened v2 cookie', async () => {
    const devices = await registry(() => NOW)
    const policy = createAccessPolicy(secret, { devices, now: () => NOW })
    const { res, calls } = response()
    const ticket = pairingTicket(secret, NOW)
    expect(policy.handlePairing(request({ url: '/pair/' + ticket }), res, '/pair/' + ticket)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.status).toBe(302)
    expect(calls[0]!.headers?.location).toBe('/')
    const setCookie = calls[0]!.headers?.['set-cookie'] ?? ''
    expect(setCookie).toContain(COOKIE_NAME + '=v2.')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=' + String(COOKIE_MAX_AGE_SECONDS))
    // The pairing bound exactly one device; no name and no UA means the default label.
    const listed = devices.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.label).toBe('未知设备')
    expect(listed[0]!.boundAt).toBe(NOW)
  })

  it('labels the binding from the ?name= parameter over the User-Agent', async () => {
    const devices = await registry(() => NOW)
    const policy = createAccessPolicy(secret, { devices, now: () => NOW })
    const ticket = pairingTicket(secret, NOW)
    const url = '/pair/' + ticket + '?name=' + encodeURIComponent('  Pixel 8 Pro  ')
    const { res } = response()
    policy.handlePairing(request({
      url,
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Expo/57' },
    }), res, '/pair/' + ticket)
    expect(devices.list()[0]!.label).toBe('Pixel 8 Pro')
    // A long name is capped at 64 characters and control characters collapse.
    const { res: second } = response()
    const long = 'x'.repeat(100)
    const url2 = '/pair/' + ticket + '?name=' + encodeURIComponent('a' + String.fromCharCode(1) + 'b ' + long)
    policy.handlePairing(request({ url: url2, headers: { 'user-agent': 'UA' } }), second, '/pair/' + ticket)
    const labels = devices.list().map(device => device.label)
    expect(labels[1]!.length).toBeLessThanOrEqual(64)
    expect(labels[1]!.startsWith('a b x')).toBe(true)
  })

  it('labels the binding from the User-Agent when no name is given', async () => {
    const devices = await registry(() => NOW)
    const policy = createAccessPolicy(secret, { devices, now: () => NOW })
    const ticket = pairingTicket(secret, NOW)
    const { res } = response()
    policy.handlePairing(request({ url: '/pair/' + ticket, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/126' } }), res, '/pair/' + ticket)
    expect(devices.list()[0]!.label).toBe('Mozilla/5.0 (Macintosh) Chrome/126')
    // An unparseable request URL degrades to the User-Agent label too.
    const { res: broken } = response()
    policy.handlePairing(request({ url: 'http://[invalid', headers: { 'user-agent': 'UA' } }), broken, '/pair/' + ticket)
    expect(devices.list()[1]!.label).toBe('UA')
    // A pairing without any URL and an array-shaped User-Agent still labels.
    const { res: arrayUa } = response()
    policy.handlePairing(request({ headers: { 'user-agent': ['ArrayUA'] } }), arrayUa, '/pair/' + ticket)
    expect(devices.list()[2]!.label).toBe('ArrayUA')
  })

  it('answers HEAD the same way', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW })
    const { res, calls } = response()
    const ticket = pairingTicket(secret, NOW)
    expect(policy.handlePairing(request({ method: 'HEAD', url: '/pair/' + ticket }), res, '/pair/' + ticket)).toBe(true)
    expect(calls[0]!.status).toBe(302)
  })

  it('answers 405 for non-GET methods on pair paths', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW })
    const { res, calls } = response()
    expect(policy.handlePairing(request({ method: 'POST' }), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(405)
  })

  it('falls back to the unknown-address bucket when the client address is missing', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW, clientAddress: () => undefined })
    const { res, calls } = response()
    expect(policy.handlePairing(request({}), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(401)
  })

  it('answers 401 for a wrong, malformed, or stale ticket', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW })
    for (const ticket of ['AAAA', 'bad ticket!', pairingTicket(secret, NOW - 86_400_000)]) {
      const { res, calls } = response()
      expect(policy.handlePairing(request({}), res, '/pair/' + ticket)).toBe(true)
      expect(calls[0]!.status).toBe(401)
    }
  })

  it('rate-limits failed attempts per address and resets on success', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW, pairMaxAttempts: 2 })
    expect(failedPairingStatus(policy)).toBe(401)
    expect(failedPairingStatus(policy)).toBe(401)
    const { res: limitedRes, calls: limitedCalls } = response()
    expect(policy.handlePairing(request({}), limitedRes, '/pair/AAAA')).toBe(true)
    expect(limitedCalls[0]!.status).toBe(429)
    expect(limitedCalls[0]!.headers?.['retry-after']).toBe('10')
    // A correct ticket always succeeds, whatever the failure window holds.
    const { res: goodRes, calls: goodCalls } = response()
    const ticket = pairingTicket(secret, NOW)
    expect(policy.handlePairing(request({ url: '/pair/' + ticket }), goodRes, '/pair/' + ticket)).toBe(true)
    expect(goodCalls[0]!.status).toBe(302)
    // Success clears the window: failures start from zero again.
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('opens a fresh window after the window elapses', async () => {
    let now = 0
    const policy = createAccessPolicy(secret, {
      devices: await registry(() => now),
      now: () => now,
      pairMaxAttempts: 1,
      pairWindowMs: 60_000,
    })
    expect(failedPairingStatus(policy)).toBe(401)
    // Still inside the window: the second wrong ticket is the one that gets limited.
    expect(failedPairingStatus(policy)).toBe(429)
    now = 60_000
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('keys the rate limit by client address', async () => {
    const policy = createAccessPolicy(secret, { devices: await registry(() => NOW), now: () => NOW, pairMaxAttempts: 1 })
    const { res: firstRes, calls: firstCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.1' }), firstRes, '/pair/AAAA')).toBe(true)
    expect(firstCalls[0]!.status).toBe(401)
    const { res: otherRes, calls: otherCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.2' }), otherRes, '/pair/AAAA')).toBe(true)
    expect(otherCalls[0]!.status).toBe(401)
  })
})
