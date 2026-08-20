import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, mintCookie } from '../src/secret.ts'
import { DeviceRegistry } from '../src/devices.ts'
import { cookieValue, createAccessPolicy, deviceName, type AccessPolicy } from '../src/policy.ts'

interface FakeRequest {
  method?: string
  headers?: IncomingMessage['headers']
  remoteAddress?: string
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

function registry(): DeviceRegistry {
  return new DeviceRegistry(undefined)
}

/** The status one wrong-token pairing attempt receives from the policy. */
function failedPairingStatus(policy: AccessPolicy): number {
  const { res, calls } = response()
  policy.handlePairing(request({}), res, '/pair/AAAA')
  return calls[0]!.status
}

describe('authorize', () => {
  it('denies every host without a cookie', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW })
    for (const host of ['127.0.0.1', '127.0.0.1:8080', 'fake.tunnel.example', '']) {
      // Every request needs the device cookie: behind the tunnel all connections
      // arrive from the loopback address and the Host header is client-controlled.
      expect(policy.authorize(request({ headers: { host } }))).toBe(false)
    }
  })

  it('admits a valid live device cookie and denies a revoked one', () => {
    const devices = registry()
    const policy = createAccessPolicy(secret, devices, { now: () => NOW })
    const deviceId = devices.register('mobile', NOW)
    const { value } = mintCookie(secret, deviceId, NOW)
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie: COOKIE_NAME + '=' + value } }))).toBe(true)
    devices.revoke(deviceId)
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie: COOKIE_NAME + '=' + value } }))).toBe(false)
  })

  it('denies a tampered cookie and refreshes lastSeen for a live one', () => {
    const devices = registry()
    const policy = createAccessPolicy(secret, devices, { now: () => NOW })
    const deviceId = devices.register('mobile', NOW)
    const { value } = mintCookie(secret, deviceId, NOW)
    expect(policy.authorize(request({ headers: { cookie: COOKIE_NAME + '=v2.x.y.AAAA' } }))).toBe(false)
    expect(policy.authorize(request({ headers: { cookie: COOKIE_NAME + '=' + value } }))).toBe(true)
    expect(policy.authorize(request({ headers: {} }))).toBe(false)
    expect(devices.snapshot()[0]?.lastSeen).toBeGreaterThanOrEqual(NOW)
  })
})

describe('cookieValue', () => {
  it('finds the dsh_remote cookie among several', () => {
    expect(cookieValue('a=1; dsh_remote=v2.x.y.z; b=2')).toBe('v2.x.y.z')
    expect(cookieValue('dsh_remote=')).toBe('')
    expect(cookieValue('a=1; b=2')).toBeUndefined()
    expect(cookieValue(undefined)).toBeUndefined()
  })
})

describe('deviceName', () => {
  it('derives a distinguishable label from the user agent', () => {
    expect(deviceName(undefined)).toBe('mobile')
    expect(deviceName(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    )).toBe('iPhone · Safari')
    expect(deviceName(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UD1A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36',
    )).toBe('Android · Chrome')
    expect(deviceName(
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    )).toBe('iPad · Safari')
    expect(deviceName(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    )).toBe('Windows · Chrome')
    expect(deviceName(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    )).toBe('macOS · Safari')
    // Edge user agents carry both "Chrome" and "Edg"; the Edge label must win.
    expect(deviceName(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
    )).toBe('Windows · Edge')
  })

  it('falls back to mobile/desktop for unknown agents', () => {
    expect(deviceName('Mozilla/5.0 (mobi) custom')).toBe('mobile')
    expect(deviceName('some/unknown agent')).toBe('desktop')
  })
})

describe('handlePairing', () => {
  it('falls through for non-pair paths', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW })
    expect(policy.handlePairing(request({}), response().res, '/api/x')).toBe(false)
    expect(policy.handlePairing(request({}), response().res, '/')).toBe(false)
  })

  it('pairs a valid one-time token: 302, location, and the hardened cookie', () => {
    const devices = registry()
    const policy = createAccessPolicy(secret, devices, { now: () => NOW })
    const { res, calls } = response()
    const token = devices.issueToken(NOW)
    expect(policy.handlePairing(request({}), res, '/pair/' + token)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.status).toBe(302)
    expect(calls[0]!.headers?.location).toBe('/')
    const setCookie = calls[0]!.headers?.['set-cookie'] ?? ''
    expect(setCookie).toContain(COOKIE_NAME + '=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=' + String(COOKIE_MAX_AGE_SECONDS))
    expect(devices.snapshot()).toHaveLength(1)
    expect(devices.snapshot()[0]?.name).toBe('mobile')
  })

  it('answers HEAD the same way and consumes the token once', () => {
    const devices = registry()
    const policy = createAccessPolicy(secret, devices, { now: () => NOW })
    const { res, calls } = response()
    const token = devices.issueToken(NOW)
    expect(policy.handlePairing(request({ method: 'HEAD' }), res, '/pair/' + token)).toBe(true)
    expect(calls[0]!.status).toBe(302)
    // The consumed token cannot pair a second device.
    const { res: secondRes, calls: secondCalls } = response()
    expect(policy.handlePairing(request({}), secondRes, '/pair/' + token)).toBe(true)
    expect(secondCalls[0]!.status).toBe(401)
  })

  it('answers 405 for non-GET methods on pair paths', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW })
    const { res, calls } = response()
    expect(policy.handlePairing(request({ method: 'POST' }), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(405)
  })

  it('falls back to the unknown-address bucket when the client address is missing', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW, clientAddress: () => undefined })
    const { res, calls } = response()
    expect(policy.handlePairing(request({}), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(401)
  })

  it('answers 401 for a wrong or malformed token', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW })
    for (const token of ['AAAA', 'bad token!']) {
      const { res, calls } = response()
      expect(policy.handlePairing(request({}), res, '/pair/' + token)).toBe(true)
      expect(calls[0]!.status).toBe(401)
    }
  })

  it('rate-limits failed attempts per address and resets on success', () => {
    const devices = registry()
    const policy = createAccessPolicy(secret, devices, { now: () => NOW, pairMaxAttempts: 2 })
    expect(failedPairingStatus(policy)).toBe(401)
    expect(failedPairingStatus(policy)).toBe(401)
    const { res: limitedRes, calls: limitedCalls } = response()
    expect(policy.handlePairing(request({}), limitedRes, '/pair/AAAA')).toBe(true)
    expect(limitedCalls[0]!.status).toBe(429)
    expect(limitedCalls[0]!.headers?.['retry-after']).toBe('10')
    // A correct token always succeeds, whatever the failure window holds.
    const { res: goodRes, calls: goodCalls } = response()
    expect(policy.handlePairing(request({}), goodRes, '/pair/' + devices.issueToken(NOW))).toBe(true)
    expect(goodCalls[0]!.status).toBe(302)
    // Success clears the window: failures start from zero again.
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('opens a fresh window after the window elapses', () => {
    const devices = registry()
    let now = 0
    const policy = createAccessPolicy(secret, devices, { now: () => now, pairMaxAttempts: 1, pairWindowMs: 60_000 })
    expect(failedPairingStatus(policy)).toBe(401)
    // Still inside the window: the second wrong token is the one that gets limited.
    expect(failedPairingStatus(policy)).toBe(429)
    now = 60_000
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('keys the rate limit by client address', () => {
    const policy = createAccessPolicy(secret, registry(), { now: () => NOW, pairMaxAttempts: 1 })
    const { res: firstRes, calls: firstCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.1' }), firstRes, '/pair/AAAA')).toBe(true)
    expect(firstCalls[0]!.status).toBe(401)
    const { res: otherRes, calls: otherCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.2' }), otherRes, '/pair/AAAA')).toBe(true)
    expect(otherCalls[0]!.status).toBe(401)
  })
})
