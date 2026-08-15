/**
 * The mobile wire carrier. Subclasses AbstractApiClient, which owns every
 * protocol invariant (rpcId mint/echo, envelope wrap/unwrap, zod value
 * parsing, heartbeat tolerance); this class contributes only the platform
 * aspects: the paired base URL, the manual session-cookie header, a
 * Hermes-safe rpcId source, the AbortSignal statics shim, 401 branding as
 * UnauthorizedError, and WebSocket downlink openers (the network server
 * answers plain GETs on the event paths with 426 — the SSE form exists only
 * for the in-process carrier).
 * @module @deepseek-ai/dsh-client-mobile
 */

import { RpcId, type HostFrame, type MuxFrame, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { UnauthorizedError } from './errors.ts'
import { ensureAbortSignalStatics, randomUuid } from './shims.ts'
import type { FetchLike } from './types.ts'

/** Transport and identity options for one paired host. */
export interface MobileApiClientOptions {
  /** Paired origin, e.g. \`https://<slug>.trycloudflare.com\`. */
  baseUrl: string
  /** The \`dsh_remote\` session cookie value. */
  cookie: string
  /** Injected fetch (expo/fetch on device; global fetch by default). */
  fetchImpl?: FetchLike
  /** Injected WebSocket factory (RN native socket by default). */
  openSocket?: SocketFactory
  /** Bounded unary call timeout; see AbstractApiClient. */
  timeoutMs?: number
}

/** The WebSocket surface both the RN socket and test doubles implement. */
export interface SocketLike {
  send?(data: string): void
  close(): void
  get onmessage(): ((event: { data: unknown }) => void) | null
  set onmessage(handler: ((event: { data: unknown }) => void) | null)
  get onopen(): (() => void) | null
  set onopen(handler: (() => void) | null)
  get onclose(): (() => void) | null
  set onclose(handler: (() => void) | null)
  get onerror(): (() => void) | null
  set onerror(handler: (() => void) | null)
}

/** Opens one socket with the session cookie header attached. */
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike

type InboxItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type FrameParser<F> = { parse(value: unknown): F }

/** Default factory: the platform WebSocket (RN passes headers as the third constructor argument). */
function defaultSocketFactory(url: string, headers: Record<string, string>): SocketLike {
  type WebSocketCtor = new (u: string, p: unknown, o: { headers: Record<string, string> }) => SocketLike
  const WebSocketCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (WebSocketCtor === undefined) throw new Error('no WebSocket implementation; inject MobileApiClientOptions.openSocket')
  return new WebSocketCtor(url, [], { headers })
}

/** Headers from a RequestInit, folded into a plain record for manual cookie injection. */
function plainHeaders(init: RequestInit | undefined): Record<string, string> {
  // Every AbstractApiClient call site passes an object literal or nothing —
  // never a Headers instance or a pair array — so the RequestInit union
  // collapses to that one shape at this carrier's only injection point.
  const source = init?.headers as Record<string, string> | undefined
  const headers: Record<string, string> = {}
  /* v8 ignore next -- every AbstractApiClient call site passes a headers object; the fallback is for the optional-init type */
  for (const [key, value] of Object.entries(source ?? {})) headers[key] = value
  return headers
}

/**
 * The wire client for one paired DSH host over the remote-access tunnel.
 * @param options - base URL, cookie, and transport injections.
 */
export class MobileApiClient extends AbstractApiClient {
  private readonly baseUrl: string
  private readonly cookieHeader: string
  private readonly fetchImpl: FetchLike
  private readonly openSocket: SocketFactory

  constructor(options: MobileApiClientOptions) {
    super(options.timeoutMs)
    ensureAbortSignalStatics()
    this.baseUrl = options.baseUrl
    this.cookieHeader = `dsh_remote=${options.cookie}`
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.openSocket = options.openSocket ?? defaultSocketFactory
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers = plainHeaders(init)
    headers.cookie = this.cookieHeader
    return this.fetchImpl(input, { ...init, headers }).then((response) => {
      // 401 is the pairing gate's answer to a missing/invalid cookie. Brand it
      // before postJson's generic non-ok throw so callers can tell re-pair
      // apart from transient transport failure.
      if (response.status === 401) throw new UnauthorizedError()
      return response
    })
  }

  protected override resolveBase(): string {
    return this.baseUrl
  }

  protected override mintRpcId(): RpcId {
    return RpcId(randomUuid())
  }

  protected override openMux(
    _payload: Parameters<MobileApiClient['events']['mux']>[0],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket('/api/events.mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<MobileApiClient['events']['host']>[0],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket('/api/events.host', signal, hostFrameSchema, onOpen)
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: FrameParser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = this.openSocket(url.href, { cookie: this.cookieHeader })
    const inbox: InboxItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: InboxItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    socket.onopen = () => { onOpen?.() }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        console.error('[client-mobile] dropping non-text WebSocket frame on ' + path)
        return
      }
      let full: ReturnType<typeof serverRequestSchema.parse>
      let frame: F
      try {
        full = serverRequestSchema.parse(JSON.parse(event.data))
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error('[client-mobile] dropping malformed WebSocket frame on ' + path, error)
        return
      }
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    socket.onclose = () => { enqueue({ kind: 'end' }) }
    socket.onerror = () => undefined
    const handleAbort = (): void => {
      try { socket.close() } catch { /* the socket may already be gone */ }
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          /* v8 ignore next -- a non-empty inbox shift cannot be undefined; the guard keeps the loop total */
          if (item === undefined) continue
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      handleAbort()
    }
  }
}
