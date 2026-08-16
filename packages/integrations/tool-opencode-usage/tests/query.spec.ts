/**
 * Unit and stub-server tests for the OpenCode Go query modes: window parsing,
 * human-readable time parsing, the api-key endpoint client, and the dashboard
 * scraper (SSR and data-slot formats). Only the network boundary is mocked.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  parseApiUsageWindow,
  parseDataSlotFormat,
  parseHumanReadableTime,
  parseSsrWindow,
  queryByApiKey,
  queryByWeb,
} from '../src/query.ts'
import type { UsageWindow } from '../src/query.ts'
import {
  DATA_SLOT_HTML_FIXTURE,
  SSR_HTML_FIXTURE,
  SSR_RESET_FIRST_HTML_FIXTURE,
  StubServer,
  UNPARSEABLE_HTML_FIXTURE,
  USAGE_API_FIXTURE,
} from './harness.ts'

const VALID_WINDOW: UsageWindow = {
  percentUsed: 20,
  percentRemaining: 80,
  resetsAt: '2026-08-16T09:10:19.423Z',
}

const NOW = Date.parse('2026-08-16T02:00:00.000Z')

describe('parseApiUsageWindow', () => {
  it('accepts an ok window with finite percent and ISO reset', () => {
    expect(parseApiUsageWindow({ status: 'ok', percent: 20, resetsAt: VALID_WINDOW.resetsAt }))
      .toEqual(VALID_WINDOW)
  })

  it('rejects a non-ok status', () => {
    expect(parseApiUsageWindow({ status: 'error', percent: 20, resetsAt: VALID_WINDOW.resetsAt })).toBeNull()
  })

  it('rejects non-finite, out-of-range, or non-numeric percent', () => {
    for (const percent of [-1, 101, Number.NaN, '20', null]) {
      expect(parseApiUsageWindow({ status: 'ok', percent, resetsAt: VALID_WINDOW.resetsAt })).toBeNull()
    }
  })

  it('rejects a non-ISO reset timestamp', () => {
    expect(parseApiUsageWindow({ status: 'ok', percent: 20, resetsAt: 'not-a-date' })).toBeNull()
  })

  it('rejects non-object window values', () => {
    for (const value of [null, undefined, 5, 'ok', []]) {
      expect(parseApiUsageWindow(value)).toBeNull()
    }
  })
})

describe('parseHumanReadableTime', () => {
  it('parses compound human countdowns', () => {
    expect(parseHumanReadableTime('1 hour 56 minutes')).toBe(1 * 3600 + 56 * 60)
    expect(parseHumanReadableTime('6 days 2 hours')).toBe(6 * 86400 + 2 * 3600)
    expect(parseHumanReadableTime('26 days 17 hours')).toBe(26 * 86400 + 17 * 3600)
    expect(parseHumanReadableTime('45 seconds')).toBe(45)
  })

  it('treats reset-now markers as zero', () => {
    for (const marker of ['reset-now', 'reset now', 'now', 'resets now', '  RESETS NOW  ']) {
      expect(parseHumanReadableTime(marker)).toBe(0)
    }
  })

  it('returns null when no duration is present', () => {
    expect(parseHumanReadableTime('about a day')).toBeNull()
    expect(parseHumanReadableTime('')).toBeNull()
    expect(parseHumanReadableTime('tomorrow')).toBeNull()
  })
})

describe('queryByApiKey', () => {
  let stub: StubServer | undefined
  afterEach(async () => {
    await stub?.stop()
    stub = undefined
  })

  it('queries the usage endpoint with a bearer key and normalizes all windows', async () => {
    stub = new StubServer(() => ({ status: 200, body: JSON.stringify(USAGE_API_FIXTURE) }))
    const baseUrl = await stub.start()
    const result = await queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 })
    expect(stub.lastRequest?.url).toBe('/zen/go/v1/usage')
    expect(stub.lastRequest?.headers.authorization).toBe('Bearer sk-test')
    expect(result.mode).toBe('api-key')
    expect(result.queriedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.windows.rolling).toEqual({ percentUsed: 6, percentRemaining: 94, resetsAt: '2026-08-16T04:06:35.215Z' })
    expect(result.windows.weekly?.percentUsed).toBe(67)
    expect(result.windows.monthly?.percentUsed).toBe(59)
  })

  it('keeps an absent window null instead of failing the query', async () => {
    const body = { usage: { rolling: USAGE_API_FIXTURE.usage.rolling, monthly: USAGE_API_FIXTURE.usage.monthly } }
    stub = new StubServer(() => ({ status: 200, body: JSON.stringify(body) }))
    const baseUrl = await stub.start()
    const result = await queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 })
    expect(result.windows.weekly).toBeNull()
    expect(result.windows.rolling?.percentUsed).toBe(6)
  })

  it('throws when no window carries usable data', async () => {
    stub = new StubServer(() => ({ status: 200, body: JSON.stringify({ usage: { rolling: { status: 'error' } } }) }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/no usable window data/)
  })

  it('throws a status-qualified error on a non-2xx response', async () => {
    stub = new StubServer(() => ({ status: 401, body: '{"error":{"message":"invalid key"}}' }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-bad', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/API error 401.*invalid key/)
  })

  it('throws on a non-JSON body', async () => {
    stub = new StubServer(() => ({ status: 200, body: '<html>not json</html>' }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/non-JSON body/)
  })

  it('throws when the response misses the usage object', async () => {
    stub = new StubServer(() => ({ status: 200, body: JSON.stringify({ ok: true }) }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/missing the usage object/)
  })

  it('surfaces the cooperative deadline as an error', async () => {
    stub = new StubServer(() => ({ status: 200, body: '{}', delayMs: 300 }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 50 }))
      .rejects.toThrow(/OPENCODE_USAGE_TIMEOUT/)
  })
})

describe('queryByWeb', () => {
  let stub: StubServer | undefined
  afterEach(async () => {
    await stub?.stop()
    stub = undefined
  })

  it('scrapes the dashboard with the auth cookie and parses the SSR payload', async () => {
    stub = new StubServer(() => ({ status: 200, body: SSR_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    const result = await queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000, now: NOW })
    expect(stub.lastRequest?.url).toBe('/workspace/ws-1/go')
    expect(stub.lastRequest?.headers.cookie).toBe('auth=cookie-1')
    expect(stub.lastRequest?.headers['user-agent']).toContain('Firefox')
    expect(result.mode).toBe('web')
    expect(result.windows.rolling).toEqual({ percentUsed: 6, percentRemaining: 94, resetsAt: new Date(NOW + 5_195_000).toISOString() })
    expect(result.windows.weekly?.percentUsed).toBe(67)
    expect(result.windows.monthly?.percentUsed).toBe(59)
  })

  it('accepts the reset-first SSR field order', async () => {
    stub = new StubServer(() => ({ status: 200, body: SSR_RESET_FIRST_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    const result = await queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000, now: NOW })
    expect(result.windows.rolling?.percentUsed).toBe(6)
    expect(result.windows.weekly?.percentUsed).toBe(67)
  })

  it('falls back to the data-slot format when no SSR payload is present', async () => {
    stub = new StubServer(() => ({ status: 200, body: DATA_SLOT_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    const result = await queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000, now: NOW })
    expect(result.windows.rolling).toEqual({
      percentUsed: 6,
      percentRemaining: 94,
      resetsAt: new Date(NOW + (3600 + 26 * 60) * 1000).toISOString(),
    })
    expect(result.windows.weekly?.percentUsed).toBe(67)
    expect(result.windows.monthly?.percentUsed).toBe(59)
    expect(result.windows.monthly?.resetsAt).toBe(new Date(NOW).toISOString())
  })

  it('throws a status-qualified error on a non-2xx dashboard response', async () => {
    stub = new StubServer(() => ({ status: 404, body: 'Not Found' }))
    const baseUrl = await stub.start()
    await expect(queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/dashboard error 404.*Not Found/)
  })

  it('throws when neither HTML format yields window data', async () => {
    stub = new StubServer(() => ({ status: 200, body: UNPARSEABLE_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    await expect(queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/no usable window data/)
  })

  it('uses the live clock when no now override is supplied', async () => {
    stub = new StubServer(() => ({ status: 200, body: SSR_HTML_FIXTURE }))
    const baseUrl = await stub.start()
    const result = await queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000 })
    const delta = Date.parse(result.windows.rolling!.resetsAt) - Date.now()
    expect(delta).toBeGreaterThan(5_000_000)
    expect(delta).toBeLessThan(6_000_000)
  })
})

/** A number far beyond Number.MAX_VALUE so Number() yields Infinity. */
const HUGE = '9'.repeat(400)

describe('parseSsrWindow branch coverage', () => {
  const windowPatterns: { rolling: [RegExp, RegExp] } = {
    rolling: [
      /rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/,
      /rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/,
    ],
  }

  it('returns the window from the percent-first match', () => {
    const html = 'rollingUsage:$R[1]={usagePercent:6,resetInSec:5195}'
    expect(parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1]))
      .toEqual({ usagePercent: 6, resetInSec: 5195 })
  })

  it('falls through an out-of-range percent to the reset-first match', () => {
    const html = `rollingUsage:\$R[1]={usagePercent:${HUGE},resetInSec:5195}`
    const parsed = parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1])
    // reset-first sees the same payload: resetInSec finite, usagePercent Infinity → null
    expect(parsed).toBeNull()
  })

  it('falls through an out-of-range reset countdown to the reset-first match', () => {
    const html = `rollingUsage:\$R[1]={usagePercent:6,resetInSec:${HUGE}}`
    expect(parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1])).toBeNull()
  })

  it('returns the window from the reset-first match when the percent-first order is absent', () => {
    const html = 'rollingUsage:$R[1]={resetInSec:5195,usagePercent:6}'
    expect(parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1]))
      .toEqual({ usagePercent: 6, resetInSec: 5195 })
  })

  it('returns null when no pattern matches', () => {
    expect(parseSsrWindow('<div>nothing here</div>', windowPatterns.rolling[0], windowPatterns.rolling[1]))
      .toBeNull()
  })

  it('rejects an out-of-range countdown in the reset-first order', () => {
    const html = `rollingUsage:\$R[1]={resetInSec:${HUGE},usagePercent:6}`
    // pct-first needs usagePercent before resetInSec, so only reset-first matches
    expect(parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1])).toBeNull()
  })

  it('rejects an out-of-range percent in the reset-first order', () => {
    const html = `rollingUsage:\$R[1]={resetInSec:5195,usagePercent:${HUGE}}`
    expect(parseSsrWindow(html, windowPatterns.rolling[0], windowPatterns.rolling[1])).toBeNull()
  })
})

describe('parseDataSlotFormat branch coverage', () => {
  const item = (body: string): string => `<div data-slot="usage-item">${body}</div>`
  const labeled = (label: string): string => `<div data-slot="usage-label">${label}</div>`
  const valued = (percent: string): string => `<div data-slot="usage-value">${percent}</div>`
  const reset = (content: string, kind = 'reset-time'): string =>
    `<span data-slot="${kind}">${content}</span>`

  it('parses valid items into their window keys', () => {
    const html = item(labeled('Rolling Usage') + valued('6%') + reset('Resets in 1 hour 26 minutes'))
      + item(labeled('Weekly Usage') + valued('67%') + reset('6 days 2 hours'))
      + item(labeled('Monthly Usage') + valued('59%') + reset('Resets now', 'reset-now'))
    const result = parseDataSlotFormat(html)
    expect(result.rolling?.usagePercent).toBe(6)
    expect(result.weekly?.usagePercent).toBe(67)
    expect(result.monthly?.resetInSec).toBe(0)
  })

  it('skips an item without a usage label', () => {
    expect(parseDataSlotFormat(item(valued('6%') + reset('1 hour')))).toEqual({})
  })

  it('skips an item without a usage value', () => {
    expect(parseDataSlotFormat(item(labeled('Rolling Usage') + reset('1 hour')))).toEqual({})
  })

  it('skips an item without a reset countdown', () => {
    expect(parseDataSlotFormat(item(labeled('Rolling Usage') + valued('6%')))).toEqual({})
  })

  it('skips an item whose reset countdown is unparseable', () => {
    expect(parseDataSlotFormat(item(labeled('Rolling Usage') + valued('6%') + reset('about a day'))))
      .toEqual({})
  })

  it('ignores items whose label names no known window', () => {
    expect(parseDataSlotFormat(item(labeled('Daily Usage') + valued('6%') + reset('1 hour'))))
      .toEqual({})
  })
})

describe('queryByApiKey error-shape branches', () => {
  let stub: StubServer | undefined
  afterEach(async () => {
    await stub?.stop()
    stub = undefined
  })

  it('truncates an oversized error body in the failure message', async () => {
    const longBody = 'x'.repeat(500)
    stub = new StubServer(() => ({ status: 500, body: longBody }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/API error 500/)
    const failure = await queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 })
      .then(() => null, (error: unknown) => (error as { message: string }).message)
    expect(failure).toContain('…')
    expect(failure?.length).toBeLessThan(160)
  })

  it('omits the snippet when a non-ok response carries an empty body', async () => {
    stub = new StubServer(() => ({ status: 500, body: '' }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow('OpenCode Go usage API error 500')
  })

  it('rejects a JSON body whose root is not an object', async () => {
    stub = new StubServer(() => ({ status: 200, body: '[1,2]' }))
    const baseUrl = await stub.start()
    await expect(queryByApiKey({ apiKey: 'sk-test', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow(/unexpected body/)
  })
})

describe('queryByWeb error-shape branches', () => {
  let stub: StubServer | undefined
  afterEach(async () => {
    await stub?.stop()
    stub = undefined
  })

  it('omits the snippet when a non-ok dashboard response carries an empty body', async () => {
    stub = new StubServer(() => ({ status: 500, body: '' }))
    const baseUrl = await stub.start()
    await expect(queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000 }))
      .rejects.toThrow('OpenCode Go dashboard error 500')
  })

  it('treats out-of-range SSR numbers as absent windows', async () => {
    const html = `<div>rollingUsage:\$R[1]={usagePercent:${HUGE},resetInSec:${HUGE}}</div>
<div>weeklyUsage:\$R[2]={usagePercent:67,resetInSec:23400}</div>`
    stub = new StubServer(() => ({ status: 200, body: html }))
    const baseUrl = await stub.start()
    const result = await queryByWeb({ workspaceId: 'ws-1', authCookie: 'cookie-1', baseUrl, timeoutMs: 5_000, now: NOW })
    expect(result.windows.rolling).toBeNull()
    expect(result.windows.weekly?.percentUsed).toBe(67)
    expect(result.windows.monthly).toBeNull()
  })
})
