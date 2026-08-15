import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, mintCookie, pairingTicket } from '../src/secret.ts'
import { cookieValue, createAccessPolicy, type AccessPolicy } from '../src/policy.ts'

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

/** The status one wrong-ticket pairing attempt receives from the policy. */
function failedPairingStatus(policy: AccessPolicy): number {
  const { res, calls } = response()
  policy.handlePairing(request({}), res, '/pair/AAAA')
  return calls[0]!.status
}

describe('authorize', () => {
  const policy = createAccessPolicy(secret, { now: () => NOW })

  it.each([
    ['127.0.0.1'],
    ['127.0.0.1:8080'],
    ['127.9.9.9'],
    ['localhost'],
    ['localhost:3080'],
    ['[::1]'],
    ['[::1]:3080'],
    ['fake.tunnel.example'],
    [''],
  ])('denies the host %s without a cookie', (host) => {
    // Every request needs the pairing cookie: behind the tunnel all connections
    // arrive from the loopback address and the Host header is client-controlled,
    // so no Host- or address-shaped shortcut may exist.
    expect(policy.authorize(request({ headers: { host } }))).toBe(false)
  })

  it('denies a spoofed loopback-shaped host without a cookie', () => {
    // A hostname merely starting with the loopback prefix is not loopback.
    expect(policy.authorize(request({ headers: { host: '127.0.0.1.evil.com' } }))).toBe(false)
    expect(policy.authorize(request({ headers: { host: '127.0.0.1.attacker.io:8080' } }))).toBe(false)
    expect(policy.authorize(request({ headers: { host: '127.evil.com' } }))).toBe(false)
  })

  it('admits any host with a valid cookie and denies a tampered one', () => {
    const { value } = mintCookie(secret, NOW)
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie: COOKIE_NAME + '=' + value } }))).toBe(true)
    expect(policy.authorize(request({ headers: { host: '127.0.0.1', cookie: COOKIE_NAME + '=' + value } }))).toBe(true)
    expect(policy.authorize(request({ headers: { host: 'fake.tunnel.example', cookie: COOKIE_NAME + '=v1.99999.AAAA' } }))).toBe(false)
    expect(policy.authorize(request({ headers: {} }))).toBe(false)
  })
})

describe('cookieValue', () => {
  it('finds the dsh_remote cookie among several', () => {
    expect(cookieValue('a=1; dsh_remote=v1.2.3; b=2')).toBe('v1.2.3')
    expect(cookieValue('dsh_remote=')).toBe('')
    expect(cookieValue('a=1; b=2')).toBeUndefined()
    expect(cookieValue(undefined)).toBeUndefined()
  })
})

describe('handlePairing', () => {
  it('falls through for non-pair paths', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW })
    expect(policy.handlePairing(request({}), response().res, '/api/x')).toBe(false)
    expect(policy.handlePairing(request({}), response().res, '/')).toBe(false)
  })

  it('pairs a valid current-day ticket: 302, location, and the hardened cookie', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW })
    const { res, calls } = response()
    const ticket = pairingTicket(secret, NOW)
    expect(policy.handlePairing(request({}), res, '/pair/' + ticket)).toBe(true)
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
  })

  it('answers HEAD the same way', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW })
    const { res, calls } = response()
    const ticket = pairingTicket(secret, NOW)
    expect(policy.handlePairing(request({ method: 'HEAD' }), res, '/pair/' + ticket)).toBe(true)
    expect(calls[0]!.status).toBe(302)
  })

  it('answers 405 for non-GET methods on pair paths', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW })
    const { res, calls } = response()
    expect(policy.handlePairing(request({ method: 'POST' }), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(405)
  })

  it('falls back to the unknown-address bucket when the client address is missing', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW, clientAddress: () => undefined })
    const { res, calls } = response()
    expect(policy.handlePairing(request({}), res, '/pair/AAAA')).toBe(true)
    expect(calls[0]!.status).toBe(401)
  })

  it('answers 401 for a wrong, malformed, or stale ticket', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW })
    for (const ticket of ['AAAA', 'bad ticket!', pairingTicket(secret, NOW - 86_400_000)]) {
      const { res, calls } = response()
      expect(policy.handlePairing(request({}), res, '/pair/' + ticket)).toBe(true)
      expect(calls[0]!.status).toBe(401)
    }
  })

  it('rate-limits failed attempts per address and resets on success', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW, pairMaxAttempts: 2 })
    expect(failedPairingStatus(policy)).toBe(401)
    expect(failedPairingStatus(policy)).toBe(401)
    const { res: limitedRes, calls: limitedCalls } = response()
    expect(policy.handlePairing(request({}), limitedRes, '/pair/AAAA')).toBe(true)
    expect(limitedCalls[0]!.status).toBe(429)
    expect(limitedCalls[0]!.headers?.['retry-after']).toBe('10')
    // A correct ticket always succeeds, whatever the failure window holds.
    const { res: goodRes, calls: goodCalls } = response()
    expect(policy.handlePairing(request({}), goodRes, '/pair/' + pairingTicket(secret, NOW))).toBe(true)
    expect(goodCalls[0]!.status).toBe(302)
    // Success clears the window: failures start from zero again.
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('opens a fresh window after the window elapses', () => {
    let now = 0
    const policy = createAccessPolicy(secret, { now: () => now, pairMaxAttempts: 1, pairWindowMs: 60_000 })
    expect(failedPairingStatus(policy)).toBe(401)
    // Still inside the window: the second wrong ticket is the one that gets limited.
    expect(failedPairingStatus(policy)).toBe(429)
    now = 60_000
    expect(failedPairingStatus(policy)).toBe(401)
  })

  it('keys the rate limit by client address', () => {
    const policy = createAccessPolicy(secret, { now: () => NOW, pairMaxAttempts: 1 })
    const { res: firstRes, calls: firstCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.1' }), firstRes, '/pair/AAAA')).toBe(true)
    expect(firstCalls[0]!.status).toBe(401)
    const { res: otherRes, calls: otherCalls } = response()
    expect(policy.handlePairing(request({ remoteAddress: '198.51.100.2' }), otherRes, '/pair/AAAA')).toBe(true)
    expect(otherCalls[0]!.status).toBe(401)
  })
})

