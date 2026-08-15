/**
 * Remote-access pairing: turn the printed `dsh web remote: https://…/pair/<ticket>`
 * URL into a reusable base URL + session cookie. The pairing GET answers 302
 * with the `dsh_remote` cookie; native clients carry that cookie header
 * manually on every later request because RN's fetch has no cookie jar.
 * @module @deepseek-ai/dsh-client-mobile
 */

import { PairingError } from './errors.ts'
import type { FetchLike } from './types.ts'

/** A paired host: the origin plus the session cookie every request must carry. */
export interface PairingRecord {
  readonly baseUrl: string
  readonly cookie: string
}

/** A parsed pairing URL: the origin and the day-scoped ticket. */
export interface ParsedPairingUrl {
  readonly baseUrl: string
  readonly ticket: string
}

/**
 * Validate and split a pairing URL. Accepted shape:
 * `https://<host>/pair/<ticket>` with a non-empty ticket.
 * @param raw - the scanned or pasted URL.
 * @returns the origin and ticket.
 */
export function parsePairingUrl(raw: string): ParsedPairingUrl {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new PairingError('invalid-url', 'unparseable URL')
  }
  if (url.protocol !== 'https:') {
    throw new PairingError('invalid-url', 'pairing requires HTTPS')
  }
  const match = /^\/pair\/([^/]+)$/.exec(url.pathname)
  if (match === null || match[1] === undefined) {
    throw new PairingError('invalid-url', 'missing pairing ticket')
  }
  let ticket: string
  try {
    ticket = decodeURIComponent(match[1])
  } catch {
    throw new PairingError('invalid-url', 'ticket is not percent-decodable')
  }
  return { baseUrl: url.origin, ticket }
}

/** Extract the `dsh_remote` cookie value from a pairing response's headers. */
export function extractSessionCookie(headers: { getSetCookie?: () => string[]; get?(name: string): string | null }): string | undefined {
  const values = headers.getSetCookie !== undefined
    ? headers.getSetCookie()
    : [headers.get?.('set-cookie') ?? '']
  for (const value of values) {
    const match = /(?:^|[,;]\s*)dsh_remote=([^,;\s]+)/.exec(value)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
  }
  return undefined
}

/**
 * Pair with the host named by a `/pair/<ticket>` URL. One attempt only: the
 * host owns the failure budget, so retrying here could lock the app out.
 * @param raw - the scanned or pasted pairing URL.
 * @param fetchImpl - the injected fetch (redirects must stay manual).
 * @returns the base URL and session cookie to persist.
 */
export async function pairWithHost(raw: string, fetchImpl: FetchLike): Promise<PairingRecord> {
  const { baseUrl, ticket } = parsePairingUrl(raw)
  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/pair/${ticket}`, { redirect: 'manual' })
  } catch (error) {
    throw new PairingError('network', String(error))
  }
  if (response.status < 300 || response.status >= 400) {
    throw new PairingError('rejected', `pairing gate answered HTTP ${response.status}`)
  }
  const cookie = extractSessionCookie(response.headers)
  if (cookie === undefined) throw new PairingError('no-cookie', 'pairing response carried no dsh_remote cookie')
  return { baseUrl, cookie }
}
