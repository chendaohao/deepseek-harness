/**
 * Transport assembly: the paired host record plus expo/fetch (WinterCG fetch
 * with streaming bodies and manual redirects — both required by the core's
 * SSE stream and the pairing redirect). UI layers import this single factory
 * instead of touching fetch, WebSocket, or cookie handling.
 */

import { fetch as expoFetch } from 'expo/fetch'
import { MobileApiClient, type FetchLike, type PairingRecord, type SocketLike } from '@deepseek-ai/dsh-client-mobile'

/**
 * Build the wire client for one paired host.
 * @param record - the paired host record (origin plus session cookie).
 * @param fetchImpl - fetch implementation; defaults to expo/fetch on device.
 * @returns the mobile API client carrying the pairing cookie on every request.
 */
export function createApi(record: PairingRecord, fetchImpl: FetchLike = expoFetch as FetchLike): MobileApiClient {
  // expo/fetch matches the WHATWG fetch signature the core's FetchLike types;
  // the RN WebSocket passes request headers as its third constructor argument
  // (the DOM-typed constructor signature has no third parameter).
  const WebSocketCtor = WebSocket as unknown as new (u: string, p?: unknown, o?: { headers: Record<string, string> }) => SocketLike
  const openSocket = (url: string, headers: Record<string, string>): SocketLike =>
    new WebSocketCtor(url, [], { headers })
  return new MobileApiClient({
    baseUrl: record.baseUrl,
    cookie: record.cookie,
    fetchImpl,
    openSocket,
  })
}
