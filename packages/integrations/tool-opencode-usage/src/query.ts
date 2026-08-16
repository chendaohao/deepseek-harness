/**
 * OpenCode Go usage retrieval: an authenticated API-key request against the
 * `/zen/go/v1/usage` endpoint, and a dashboard scrape of the workspace page
 * for the cookie-based web scenario. Both produce one normalized window view.
 * @module @deepseek-ai/dsh-tool-opencode-usage/query
 */

import { deadline } from '@deepseek-ai/dsh-timeout'

/** Query acquisition mode reported in the canonical result. */
export type UsageMode = 'api-key' | 'web'

/** One usage window: percent of the window already consumed plus its reset. */
export interface UsageWindow {
  /** Percent of the window consumed, 0-100. */
  percentUsed: number
  /** 100 minus {@link UsageWindow.percentUsed}. */
  percentRemaining: number
  /** ISO timestamp of the window reset. */
  resetsAt: string
}

/** Window identity in request order (dashboard display order). */
export type UsageWindowKey = 'rolling' | 'weekly' | 'monthly'

/** Canonical query result: every window, with absent windows as null. */
export interface UsageResult {
  mode: UsageMode
  queriedAt: string
  windows: Record<UsageWindowKey, UsageWindow | null>
}

/** Timeout code surfaced through {@link TimeoutReason} on deadline expiry. */
export const OPENCODE_USAGE_TIMEOUT_CODE = 'OPENCODE_USAGE_TIMEOUT'

/** Default cooperative request budget (ms) when no config overrides it. */
export const DEFAULT_OPENCODE_USAGE_TIMEOUT_MS = 15_000

/** Browser User-Agent sent on dashboard scrapes. */
const DASHBOARD_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/148.0'

/** Cap on response text kept in error messages. */
const MAX_ERROR_SNIPPET_CHARS = 120

/** Shared inputs for every query. */
export interface QueryOptions {
  /** API origin; tests point this at a local stub. */
  baseUrl: string
  /** Cooperative timeout budget in milliseconds. */
  timeoutMs: number
  /** Upstream cancellation; fused with the deadline. */
  signal?: AbortSignal
}

/** Inputs for the API-key query. */
export interface ApiKeyQueryOptions extends QueryOptions {
  apiKey: string
}

/** Inputs for the web (dashboard scrape) query. */
export interface WebQueryOptions extends QueryOptions {
  workspaceId: string
  authCookie: string
  /** Clock override for deterministic tests; defaults to Date.now(). */
  now?: number
}

/**
 * Collapse arbitrary response text into a single-line diagnostic snippet.
 * @param text - raw response text.
 * @returns a whitespace-normalized, capped snippet.
 */
function sanitizeMessage(text: string): string {
  const collapsed = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_ERROR_SNIPPET_CHARS) return collapsed
  return collapsed.slice(0, MAX_ERROR_SNIPPET_CHARS) + '…'
}

/**
 * GET with the upstream signal fused into a cooperative deadline. The caller
 * must keep the returned disposable alive for the request duration (using).
 * @param url - request URL.
 * @param init - fetch init (headers etc.).
 * @param options - query options carrying the deadline.
 * @returns the fetch response.
 */
async function fetchWithinDeadline(
  url: string,
  init: RequestInit,
  options: QueryOptions,
): Promise<Response> {
  using d = deadline(options.signal, options.timeoutMs, OPENCODE_USAGE_TIMEOUT_CODE)
  return await fetch(url, { ...init, signal: d.signal })
}

/** True when the value is a finite non-negative number (usage percentage). */
function isFinitePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

/** True when the value parses as an ISO timestamp. */
function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
  )
}

/**
 * Normalize one API window object ({`status`, `percent`, `resetsAt`}). A
 * non-ok status, missing fields, or invalid values yield null: one broken
 * window must not fail the whole query.
 * @param value - the raw window value.
 * @returns the normalized window, or null.
 */
export function parseApiUsageWindow(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const window = value as Record<string, unknown>
  if (window.status !== 'ok') return null
  if (!isFinitePercent(window.percent)) return null
  if (!isIsoTimestamp(window.resetsAt)) return null
  const percentUsed = window.percent
  return { percentUsed, percentRemaining: 100 - percentUsed, resetsAt: window.resetsAt }
}

/**
 * Query the OpenCode Go usage API with a bearer api key.
 * @param options - api key and query options.
 * @returns the normalized usage result.
 */
export async function queryByApiKey(options: ApiKeyQueryOptions): Promise<UsageResult> {
  const url = options.baseUrl.replace(/\/$/, '') + '/zen/go/v1/usage'
  const response = await fetchWithinDeadline(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
      },
    },
    options,
  )
  if (!response.ok) {
    const snippet = sanitizeMessage(await response.text())
    throw new Error(
      `OpenCode Go usage API error ${response.status}${snippet ? `: ${snippet}` : ''}`,
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('OpenCode Go usage API returned non-JSON body')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('OpenCode Go usage API returned an unexpected body')
  }
  const usage = (body as Record<string, unknown>).usage
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    throw new Error('OpenCode Go usage API response is missing the usage object')
  }
  const source = usage as Record<string, unknown>
  const windows: Record<UsageWindowKey, UsageWindow | null> = {
    rolling: parseApiUsageWindow(source.rolling),
    weekly: parseApiUsageWindow(source.weekly),
    monthly: parseApiUsageWindow(source.monthly),
  }
  if (!windows.rolling && !windows.weekly && !windows.monthly) {
    throw new Error('OpenCode Go usage API returned no usable window data')
  }
  return { mode: 'api-key', queriedAt: new Date().toISOString(), windows }
}

/* ------------------------------------------------------------------ *
 * Dashboard scrape (web mode)
 * ------------------------------------------------------------------ */

/** One scraped window before clock normalization. */
interface ScrapedWindowUsage {
  usagePercent: number
  resetInSec: number
}

/** SolidJS SSR hydration field pattern; either field order may appear. */
const SCRAPED_NUMBER_PATTERN = String.raw`(-?\d+(?:\.\d+)?)`

const RE_ROLLING_PCT_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)
const RE_ROLLING_RESET_FIRST = new RegExp(
  String.raw`rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)
const RE_WEEKLY_PCT_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)
const RE_WEEKLY_RESET_FIRST = new RegExp(
  String.raw`weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)
const RE_MONTHLY_PCT_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)
const RE_MONTHLY_RESET_FIRST = new RegExp(
  String.raw`monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:${SCRAPED_NUMBER_PATTERN}[^}]*usagePercent:${SCRAPED_NUMBER_PATTERN}[^}]*\}`,
)

/** The three window regex pairs in dashboard display order. */
const SSR_WINDOW_PATTERNS: ReadonlyArray<{
  key: UsageWindowKey
  pctFirst: RegExp
  resetFirst: RegExp
}> = [
  { key: 'rolling', pctFirst: RE_ROLLING_PCT_FIRST, resetFirst: RE_ROLLING_RESET_FIRST },
  { key: 'weekly', pctFirst: RE_WEEKLY_PCT_FIRST, resetFirst: RE_WEEKLY_RESET_FIRST },
  { key: 'monthly', pctFirst: RE_MONTHLY_PCT_FIRST, resetFirst: RE_MONTHLY_RESET_FIRST },
]

/**
 * Parse one window from the SolidJS SSR hydration payload (either field order).
 * @param html - dashboard HTML.
 * @param pctFirst - percent-first pattern.
 * @param resetFirst - reset-first pattern.
 * @returns the scraped window, or null.
 */
export function parseSsrWindow(
  html: string,
  pctFirst: RegExp,
  resetFirst: RegExp,
): ScrapedWindowUsage | null {
  const pctFirstMatch = pctFirst.exec(html)
  if (pctFirstMatch) {
    /* v8 ignore start -- the regex's \d+ quantifier guarantees both groups on a match */
    const usagePercent = Number(pctFirstMatch[1] ?? Number.NaN)
    const resetInSec = Number(pctFirstMatch[2] ?? Number.NaN)
    /* v8 ignore stop */
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec }
    }
  }
  const resetFirstMatch = resetFirst.exec(html)
  if (resetFirstMatch) {
    /* v8 ignore start -- the regex's \d+ quantifier guarantees both groups on a match */
    const resetInSec = Number(resetFirstMatch[1] ?? Number.NaN)
    const usagePercent = Number(resetFirstMatch[2] ?? Number.NaN)
    /* v8 ignore stop */
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec }
    }
  }
  return null
}

/**
 * Parse a human-readable countdown like "1 hour 56 minutes" or "26 days 17
 * hours" into seconds. Returns null when the string carries no duration.
 * @param timeStr - the raw countdown text.
 * @returns seconds until reset, or null.
 */
export function parseHumanReadableTime(timeStr: string): number | null {
  const normalized = timeStr.toLowerCase().replace(/\s+/g, ' ').trim()
  if (['reset-now', 'reset now', 'now', 'resets now'].includes(normalized)) return 0
  let totalSeconds = 0
  let found = false
  const units: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)\s*days?/, 86_400],
    [/(\d+(?:\.\d+)?)\s*hours?/, 3_600],
    [/(\d+(?:\.\d+)?)\s*minutes?/, 60],
    [/(\d+(?:\.\d+)?)\s*seconds?/, 1],
  ]
  for (const [re, multiplier] of units) {
    const match = re.exec(normalized)
    if (!match) continue
    found = true
    totalSeconds += Number(match[1]) * multiplier
  }
  return found ? totalSeconds : null
}

/**
 * Parse the newer data-slot HTML format into scraped windows by label.
 * @param html - dashboard HTML.
 * @returns windows keyed by window name; absent windows stay absent.
 */
export function parseDataSlotFormat(html: string): Partial<Record<UsageWindowKey, ScrapedWindowUsage>> {
  const result: Partial<Record<UsageWindowKey, ScrapedWindowUsage>> = {}
  const items = html.split('data-slot="usage-item"')
  for (const content of items.slice(1)) {
    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</)
    if (!labelMatch) continue
    /* v8 ignore next -- the regex's + quantifier guarantees group 1 on a match */
    const label = (labelMatch[1] ?? '').trim().toLowerCase()
    const usageMatch = content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/)
    if (!usageMatch) continue
    const usagePercent = Number(usageMatch[1])
    const resetMatch = content.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/)
    if (!resetMatch) continue
    /* v8 ignore next -- the regex's *? quantifier guarantees group 2 (possibly empty) on a match */
    const resetContent = (resetMatch[2] ?? '')
      .replace(/<!--\$-->/g, '')
      .replace(/<!--\/-->/g, '')
      .replace(/Resets?\s*in\s*/i, '')
      .trim()
    const resetInSec = resetMatch[1] === 'reset-now' ? 0 : parseHumanReadableTime(resetContent)
    if (!Number.isFinite(usagePercent) || resetInSec === null || !Number.isFinite(resetInSec)) {
      continue
    }
    let windowKey: UsageWindowKey | null = null
    if (label.includes('rolling')) windowKey = 'rolling'
    else if (label.includes('weekly')) windowKey = 'weekly'
    else if (label.includes('monthly')) windowKey = 'monthly'
    if (windowKey) result[windowKey] = { usagePercent, resetInSec }
  }
  return result
}

/**
 * Normalize scraped windows against a clock: remaining percent and an ISO
 * reset time derived from the server-side countdown.
 * @param scraped - scraped windows keyed by name.
 * @param now - current epoch milliseconds.
 * @returns normalized windows with missing entries null.
 */
function normalizeScrapedWindows(
  scraped: Partial<Record<UsageWindowKey, ScrapedWindowUsage>>,
  now: number,
): Record<UsageWindowKey, UsageWindow | null> {
  const result: Record<UsageWindowKey, UsageWindow | null> = {
    rolling: null,
    weekly: null,
    monthly: null,
  }
  for (const key of ['rolling', 'weekly', 'monthly'] as const) {
    const window = scraped[key]
    if (!window) continue
    const usagePercent = Math.max(0, window.usagePercent)
    const resetInSec = Math.max(0, window.resetInSec)
    result[key] = {
      percentUsed: usagePercent,
      percentRemaining: 100 - usagePercent,
      resetsAt: new Date(now + resetInSec * 1000).toISOString(),
    }
  }
  return result
}

/**
 * Scrape the OpenCode Go workspace dashboard with the auth cookie. Tries the
 * SolidJS SSR hydration payload first, then the data-slot HTML format.
 * @param options - workspace id, auth cookie, and query options.
 * @returns the normalized usage result.
 */
export async function queryByWeb(options: WebQueryOptions): Promise<UsageResult> {
  const url =
    options.baseUrl.replace(/\/$/, '')
    + '/workspace/'
    + encodeURIComponent(options.workspaceId)
    + '/go'
  const response = await fetchWithinDeadline(
    url,
    {
      method: 'GET',
      headers: {
        'User-Agent': DASHBOARD_USER_AGENT,
        Accept: 'text/html',
        Cookie: `auth=${options.authCookie}`,
      },
    },
    options,
  )
  if (!response.ok) {
    const snippet = sanitizeMessage(await response.text())
    throw new Error(
      `OpenCode Go dashboard error ${response.status}${snippet ? `: ${snippet}` : ''}`,
    )
  }
  const html = await response.text()
  const now = options.now ?? Date.now()
  const ssr: Partial<Record<UsageWindowKey, ScrapedWindowUsage>> = {}
  for (const { key, pctFirst, resetFirst } of SSR_WINDOW_PATTERNS) {
    const parsed = parseSsrWindow(html, pctFirst, resetFirst)
    if (parsed) ssr[key] = parsed
  }
  const scraped = Object.keys(ssr).length > 0 ? ssr : parseDataSlotFormat(html)
  const windows = normalizeScrapedWindows(scraped, now)
  if (!windows.rolling && !windows.weekly && !windows.monthly) {
    throw new Error('OpenCode Go dashboard returned no usable window data')
  }
  return { mode: 'web', queriedAt: new Date(now).toISOString(), windows }
}
