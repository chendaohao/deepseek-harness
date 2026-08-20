// @vitest-environment jsdom
/** Mobile wire layer: unary RPC envelope + error folding, rpcId minting, and mux frame parsing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callUnary, mintRpcId } from '../src/mobile/rpc.ts'
import { EventsClient, parseFrame, type WebSocketLike } from '../src/mobile/events.ts'

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as Response
}

/** Parse the client-request envelope a fetch mock received (always a JSON string body). */
function requestBody(init?: RequestInit): { rpcId: string } {
  return JSON.parse(init?.body as string) as { rpcId: string }
}

/** A fetch mock that echoes the request's rpcId, like the real carrier. */
function echoFetch(value: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    return jsonResponse({ type: 'server-response', rpcId: requestBody(init).rpcId, result: { ok: true, value } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callUnary', () => {
  it('posts the client-request envelope to /api/<method> and resolves the value', async () => {
    const fetchMock = echoFetch({ items: [{ sessionId: 's1' }] })
    vi.stubGlobal('fetch', fetchMock)
    const result = await callUnary<{ items: unknown[] }>('session.list', {})
    expect(result).toEqual({ ok: true, value: { items: [{ sessionId: 's1' }] } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/session.list')
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    const body = requestBody(init) as { type: string; rpcId: string; method: string; payload: unknown }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session.list')
    expect(body.payload).toEqual({})
    expect(typeof body.rpcId).toBe('string')
  })

  it('folds a business error into { ok: false, error }', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return jsonResponse({
        type: 'server-response',
        rpcId: requestBody(init).rpcId,
        result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: { sessionId: 'x' } } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await callUnary<unknown>('session.history', { sessionId: 'x' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'session-not-found', message: 'no such session', details: { sessionId: 'x' } },
    })
  })

  it('folds a non-2xx HTTP status into an http error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)))
    const result = await callUnary<unknown>('session.list', {})
    expect(result).toEqual({ ok: false, error: { code: 'http', message: 'HTTP 500' } })
  })

  it('folds a network failure into a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await callUnary<unknown>('session.list', {})
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'transport failed: network down' } })
  })

  it('bounds a never-resolving fetch with the unary timeout', async () => {
    // A fetch that never settles but honors the abort signal: over a remote link
    // a dropped response must fold to a transport error, not hang forever.
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })))
    const pending = callUnary<unknown>('session.history', { sessionId: 's1' }, undefined, 25)
    const result = await Promise.race([
      pending,
      new Promise<{ timeout: true }>((resolve) => { setTimeout(() => { resolve({ timeout: true }) }, 500) }),
    ])
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'transport failed: aborted' } })
  })

  it('rejects a response envelope with a mismatched rpcId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ type: 'server-response', rpcId: 'other', result: { ok: true, value: 1 } })))
    const result = await callUnary<unknown>('session.list', {})
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'response envelope mismatch' } })
  })

  it('folds a non-JSON response body into a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } } as unknown as Response)))
    const result = await callUnary<unknown>('session.list', {})
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'malformed response body' } })
  })

  it('mints unique rpc ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = mintRpcId()
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })
})

describe('parseFrame', () => {
  it('extracts a session/event frame from a server-request envelope', () => {
    const frame = parseFrame(JSON.stringify({
      type: 'server-request',
      rpcId: 'r1',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 's1',
        event: { type: 'assistant/chunk', seq: 3, time: 123, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
      },
    }))
    expect(frame).toEqual({
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'assistant/chunk', seq: 3, time: 123, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
    })
  })

  it('drops non-session/event frames and malformed payloads', () => {
    expect(parseFrame(JSON.stringify({ type: 'server-request', rpcId: 'r1', method: 'stream/heartbeat', payload: { type: 'stream/heartbeat' } }))).toBeUndefined()
    expect(parseFrame('not json')).toBeUndefined()
    expect(parseFrame(JSON.stringify({ type: 'other' }))).toBeUndefined()
    expect(parseFrame(JSON.stringify({ type: 'server-request', rpcId: 'r1', method: 'session/event', payload: { type: 'session/event', sessionId: 's1', event: { type: 'x' } } }))).toBeUndefined()
  })
})

/** A scriptable fake socket: tests drive open/message/close and read the client's reactions. */
function fakeSocket() {
  const handlers = {
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
  }
  const close = vi.fn()
  const socket = {
    get onopen() { return handlers.onopen },
    set onopen(value) { handlers.onopen = value },
    get onmessage() { return handlers.onmessage },
    set onmessage(value) { handlers.onmessage = value },
    get onerror() { return handlers.onerror },
    set onerror(value) { handlers.onerror = value },
    get onclose() { return handlers.onclose },
    set onclose(value) { handlers.onclose = value },
    close,
  } satisfies WebSocketLike
  return { socket, handlers, close }
}

function eventFrame(sessionId: string, seq: number): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId: `r${seq}`,
    method: 'session/event',
    payload: {
      type: 'session/event',
      sessionId,
      event: { type: 'assistant/chunk', seq, time: seq, data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
    },
  })
}

function heartbeatFrame(): string {
  return JSON.stringify({ type: 'server-request', rpcId: 'hb', method: 'stream/heartbeat', payload: { type: 'stream/heartbeat' } })
}

describe('EventsClient idle watchdog', () => {
  it('recycles a silently-dead socket into polling when no frame arrives for idleTimeoutMs', async () => {
    vi.useFakeTimers()
    const { socket, handlers, close } = fakeSocket()
    const pollLatest = vi.fn(async () => ({ events: [], hasMore: false }))
    const client = new EventsClient('ws://x/api/events.mux', {
      socketFactory: () => socket,
      pollLatest,
      pollIntervalMs: 10,
      idleTimeoutMs: 30,
    })
    client.start()
    handlers.onopen?.(undefined)
    client.observe('s1')

    // Frames (heartbeats included) reset the watchdog: no polling while live.
    handlers.onmessage?.({ data: heartbeatFrame() })
    await vi.advanceTimersByTimeAsync(25)
    expect(pollLatest).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    // Silence past idleTimeoutMs: the watchdog recycles the socket, exactly as
    // if the transport had closed without a close frame.
    await vi.advanceTimersByTimeAsync(30)
    expect(close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(pollLatest).toHaveBeenCalled()

    client.stop()
    vi.useRealTimers()
  })

  it('keeps polling dormant while session/event frames keep arriving', async () => {
    vi.useFakeTimers()
    const { socket, handlers, close } = fakeSocket()
    const pollLatest = vi.fn(async () => ({ events: [], hasMore: false }))
    const frames: string[] = [eventFrame('s1', 1), eventFrame('s1', 2), eventFrame('s1', 3)]
    const client = new EventsClient('ws://x/api/events.mux', {
      socketFactory: () => socket,
      pollLatest,
      pollIntervalMs: 10,
      idleTimeoutMs: 30,
    })
    client.start()
    handlers.onopen?.(undefined)
    client.observe('s1')

    for (const data of frames) {
      handlers.onmessage?.({ data })
      await vi.advanceTimersByTimeAsync(20)
      expect(close).not.toHaveBeenCalled()
    }
    expect(pollLatest).not.toHaveBeenCalled()

    client.stop()
    vi.useRealTimers()
  })

  it('does not arm the watchdog when idleTimeoutMs is 0', async () => {
    vi.useFakeTimers()
    const { socket, handlers, close } = fakeSocket()
    const pollLatest = vi.fn(async () => ({ events: [], hasMore: false }))
    const client = new EventsClient('ws://x/api/events.mux', {
      socketFactory: () => socket,
      pollLatest,
      idleTimeoutMs: 0,
    })
    client.start()
    handlers.onopen?.(undefined)
    client.observe('s1')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(close).not.toHaveBeenCalled()
    expect(pollLatest).not.toHaveBeenCalled()

    client.stop()
    vi.useRealTimers()
  })

  it('recycles a socket that never opens into polling + reconnect via the connect-time watchdog', async () => {
    vi.useFakeTimers()
    const { socket, close } = fakeSocket()
    const pollLatest = vi.fn(async () => ({ events: [], hasMore: false }))
    const socketFactory = vi.fn(() => socket)
    const client = new EventsClient('ws://x/api/events.mux', {
      socketFactory,
      pollLatest,
      pollIntervalMs: 10,
      idleTimeoutMs: 30,
    })
    client.start()
    client.observe('s1')
    expect(socketFactory).toHaveBeenCalledTimes(1)

    // No onopen and no frames (a carrier swallowing the upgrade): the
    // connect-time watchdog still fires and recycles into polling + reconnect.
    await vi.advanceTimersByTimeAsync(40)
    expect(close).toHaveBeenCalled()
    expect(pollLatest).toHaveBeenCalled()

    // The backoff schedules a reconnect through the same factory.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(socketFactory).toHaveBeenCalledTimes(2)

    client.stop()
    vi.useRealTimers()
  })
})
