/**
 * Request policy of the remote-access proxy: the authorization gate (a valid
 * session cookie only), the /pair/<ticket> exchange with its failure budget
 * keyed by client address, and the friendly HTML pages unpaired visitors see.
 * @module @deepseek-ai/dsh-remote-access/policy
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME, mintCookie, verifyCookie, verifyTicket } from './secret.ts'

/** Default pairing-attempt budget per address per window. */
const PAIR_MAX_ATTEMPTS = 10
/** Default rate-limit window for pairing attempts. */
const PAIR_WINDOW_MS = 600_000
/** Accepted pairing-ticket spelling: URL-safe token, bounded length. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Page an unpaired or unauthenticated visitor receives instead of the app. */
export const PAIR_REQUIRED_PAGE = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>需要配对 · DeepSeek Harness</title></head>',
  '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;',
  'align-items:center;justify-content:center;background:#f5f5f4;color:#1c1917">',
  '<main style="max-width:30em;padding:2em">',
  '<h1 style="font-size:1.4em">需要配对</h1>',
  '<p>此页面是 <code>dsh web --remote</code> 开启的远程入口。请在电脑终端扫描打印的二维码完成配对后再访问。</p>',
  '<p>若二维码已过期或已轮换，请回到终端重新运行 <code>dsh web --remote</code> 获取新的二维码。</p>',
  '</main></body></html>',
].join('')

/** Page answering a rate-limited pairing address. */
const PAIR_RATE_LIMITED_PAGE = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>尝试过多 · DeepSeek Harness</title></head>',
  '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;',
  'align-items:center;justify-content:center;background:#f5f5f4;color:#1c1917">',
  '<main style="max-width:30em;padding:2em">',
  '<h1 style="font-size:1.4em">尝试次数过多</h1>',
  '<p>配对尝试过于频繁，请稍后再试。</p>',
  '</main></body></html>',
].join('')

/** Decisions the proxy asks of the access policy for every request. */
export interface AccessPolicy {
  /**
   * Whether the request may reach the proxied target: only a valid session
   * cookie admits it. There is no Host- or address-based shortcut: behind the
   * tunnel every connection arrives from the loopback address and the Host
   * header is client-controlled, so loopback-shaped Hosts are as remote as
   * any other.
   * @param req - incoming HTTP request.
   * @returns true to forward, false to answer 401 with the pairing page.
   */
  authorize(req: IncomingMessage): boolean
  /**
   * Answer a pairing request at /pair/<ticket>; never forwards.
   * @param req - incoming HTTP request.
   * @param res - response the policy owns to completion when returning true.
   * @param pathname - decoded request pathname.
   * @returns true when the path is pair-owned (answered), false to fall through.
   */
  handlePairing(req: IncomingMessage, res: ServerResponse, pathname: string): boolean
}

/** Rate-limit window state for one pairing address. */
interface AttemptWindow {
  /** Window start in epoch milliseconds. */
  startedAt: number
  /** Failed attempts inside the current window. */
  failures: number
}

/**
 * Build the default access policy for one master secret.
 * @param secret - the master pairing secret.
 * @param options - test-replaceable rate bounds and time/address sources.
 * @returns the policy object the proxy consults per request.
 */
export function createAccessPolicy(secret: Buffer, options: {
  pairMaxAttempts?: number
  pairWindowMs?: number
  now?: () => number
  clientAddress?: (req: IncomingMessage) => string | undefined
} = {}): AccessPolicy {
  const maxAttempts = options.pairMaxAttempts ?? PAIR_MAX_ATTEMPTS
  const windowMs = options.pairWindowMs ?? PAIR_WINDOW_MS
  const now = options.now ?? Date.now
  const clientAddress = options.clientAddress ?? (req => req.socket.remoteAddress)
  const windows = new Map<string, AttemptWindow>()

  const authorize = (req: IncomingMessage): boolean =>
    verifyCookie(secret, cookieValue(req.headers.cookie), now())

  const handlePairing = (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
    if (!pathname.startsWith('/pair/')) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writePage(res, 405, PAIR_REQUIRED_PAGE)
      return true
    }
    const ticket = pathname.slice('/pair/'.length)
    const address = clientAddress(req) ?? 'unknown'
    // Verification runs before the limit so the legitimate owner's ticket always
    // succeeds; the window counts failed attempts only.
    if (!TICKET_PATTERN.test(ticket) || !verifyTicket(secret, ticket, now())) {
      if (rateExceeded(address, now())) {
        writePage(res, 429, PAIR_RATE_LIMITED_PAGE, { 'retry-after': String(Math.ceil(windowMs / 60_000)) })
        return true
      }
      recordFailure(address, now())
      writePage(res, 401, PAIR_REQUIRED_PAGE)
      return true
    }
    windows.delete(address)
    const { value } = mintCookie(secret, now())
    res.writeHead(302, {
      location: '/',
      'set-cookie': COOKIE_NAME + '=' + value + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + String(COOKIE_MAX_AGE_SECONDS),
    })
    res.end()
    return true
  }

  const rateExceeded = (address: string, current: number): boolean => {
    const window = windows.get(address)
    if (window === undefined || current - window.startedAt >= windowMs) return false
    return window.failures >= maxAttempts
  }

  const recordFailure = (address: string, current: number): void => {
    const window = windows.get(address)
    if (window === undefined || current - window.startedAt >= windowMs) {
      windows.set(address, { startedAt: current, failures: 1 })
      return
    }
    window.failures++
  }

  return { authorize, handlePairing }
}

/**
 * The dsh_remote value out of a Cookie header, when present.
 * @param header - the raw Cookie header of a request.
 * @returns the cookie value, or undefined when the header carries none.
 */
export function cookieValue(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) return rest.join('=')
  }
  return undefined
}

/** Write one HTML page with a trailing-newline-safe byte length. */
function writePage(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  })
  res.end(body)
}

