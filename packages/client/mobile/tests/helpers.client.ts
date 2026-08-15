/**
 * Shared fixtures for the mobile client package specs: canned wire responses,
 * a scriptable WebSocket double, and a route-based fake fetch.
 * @module tests
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SocketLike } from '../src/client.ts'
import type { FetchLike } from '../src/types.ts'

/** One JSON HTTP response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A server-response envelope echoing a client rpcId with a success value. */
export function serverResponse(rpcId: string, value: unknown): Record<string, unknown> {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

/** A server-response envelope carrying a business error. */
export function serverError(rpcId: string, message = 'boom', code = 'internal'): Record<string, unknown> {
  return { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } }
}

/** Echo the request's rpcId back with a success value (protocol echo invariant). */
export function echoServerResponse(init: RequestInit | undefined, value: unknown): Response {
  const body = JSON.parse(init?.body as string) as { rpcId: string }
  return jsonResponse(serverResponse(body.rpcId, value))
}

/** Echo the request's rpcId back with a business error. */
export function echoServerError(init: RequestInit | undefined, message = 'boom', code = 'internal'): Response {
  const body = JSON.parse(init?.body as string) as { rpcId: string }
  return jsonResponse(serverError(body.rpcId, message, code))
}

/** A scriptable WebSocket double whose frames the test pushes on demand. */
export interface SocketMock extends SocketLike {
  push(payload: unknown, rpcId?: string): void
  close(): void
  /** Fired after the handler attaches (a connecting socket); call freely. */
  open(): void
  /** Deliver one message event through the handler the carrier installed. */
  emitMessage(data: unknown): void
  /** Deliver one error event through the handler the carrier installed. */
  emitError(): void
  readonly sent: string[]
}

/** Build a WebSocket double; the test drives open/close/frames explicitly. */
function socketMock(): SocketMock {
  const handlers = {
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
  }
  const sent: string[] = []
  let closed = false
  const socket: SocketMock = {
    sent,
    send: (data: string) => { sent.push(data) },
    open: () => {
      if (!closed) handlers.onopen?.()
    },
    close: () => {
      if (!closed) {
        closed = true
        handlers.onclose?.()
      }
    },
    push: (payload, rpcId = 'frame-1') => {
      if (closed) return
      const envelope = { type: 'server-request', rpcId, method: 'events.mux', payload }
      handlers.onmessage?.({ data: JSON.stringify(envelope) })
    },
    emitMessage: (data) => {
      handlers.onmessage?.({ data })
    },
    emitError: () => {
      handlers.onerror?.()
    },
    get onopen() { return handlers.onopen },
    set onopen(handler) { handlers.onopen = handler },
    get onmessage() { return handlers.onmessage },
    set onmessage(handler) { handlers.onmessage = handler },
    get onclose() { return handlers.onclose },
    set onclose(handler) { handlers.onclose = handler },
    get onerror() { return handlers.onerror },
    set onerror(handler) { handlers.onerror = handler },
  }
  return socket
}

/** A socket factory recording every socket plus the URL/headers it opened with. */
export interface SocketFactoryRig {
  factory(url: string, headers: Record<string, string>): SocketMock
  sockets: SocketMock[]
  calls: { url: string; headers: Record<string, string> }[]
}

/** Build the recording socket factory used by the mobile rigs. */
export function socketFactoryRig(): SocketFactoryRig {
  const sockets: SocketMock[] = []
  const calls: SocketFactoryRig['calls'] = []
  return {
    sockets,
    calls,
    factory: (url, headers) => {
      const socket = socketMock()
      calls.push({ url, headers })
      sockets.push(socket)
      return socket
    },
  }
}

/** Route-based fake fetch: keys are pathnames, values answer one call. */
export interface FakeFetch {
  readonly impl: FetchLike
  readonly calls: { url: string; init: RequestInit | undefined }[]
  /** Routes consulted in insertion order; a route may return a fresh response per call. */
  routes: Map<string, (init: RequestInit | undefined, url: string) => Response | Promise<Response>>
}

/** Build a fake fetch answering by pathname, recording every call. */
export function fakeFetch(): FakeFetch {
  const calls: FakeFetch['calls'] = []
  const routes = new Map<string, (init: RequestInit | undefined, url: string) => Response | Promise<Response>>()
  const impl: FetchLike = (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    const path = new URL(url).pathname
    const route = routes.get(path)
    if (route === undefined) return Promise.resolve(new Response('no route: ' + path, { status: 404 }))
    return Promise.resolve(route(init, url))
  }
  return { impl, calls, routes }
}

/** A minimal session event fixture; extras merge into the event (e.g. sourceEventSeqs). */
export function sessionEvent(type: SessionEvent['type'], seq: number, data: unknown, extra: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...extra } as unknown as SessionEvent
}

/** A history page entry: the event wrapped for the session.history value. */
export function historyEntry(type: SessionEvent['type'], seq: number, data: unknown, extra: Record<string, unknown> = {}): unknown {
  return { event: sessionEvent(type, seq, data, extra) }
}

/** A user/message-shaped data payload. */
export function userMessageData(text: string, rpcId?: string): unknown {
  return {
    id: 'm' + String(text.length),
    role: 'user',
    content: [{ type: 'text', text }],
    source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
  }
}
