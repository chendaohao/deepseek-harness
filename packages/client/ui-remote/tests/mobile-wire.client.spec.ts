// @vitest-environment jsdom
/** Mobile wire layer: unary RPC envelope + error folding, rpcId minting, and remote-mux frame parsing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callUnary, mintRpcId } from '../src/mobile/rpc.ts'
import { EventsClient, muxUrl, type SessionSnapshotFrame } from '../src/mobile/events.ts'
import { parseMuxFrame, type WebSocketLike } from '../src/mobile/mux.ts'

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
  it('posts the client-request envelope to /api/<endpoint> with the args payload', async () => {
    const fetchMock = echoFetch({ items: [{ sessionId: 's1' }] })
    vi.stubGlobal('fetch', fetchMock)
    const result = await callUnary<{ items: unknown[] }>('session/list', { _request: {} })
    expect(result).toEqual({ ok: true, value: { items: [{ sessionId: 's1' }] } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/session/list')
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    const body = requestBody(init) as { type: string; rpcId: string; method: string; payload: { args: unknown } }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session/list')
    expect(body.payload).toEqual({ args: { _request: {} } })
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
    const result = await callUnary<unknown>('session/page', { request: { address: { kind: 'session', sessionId: 'x' }, throughSeq: 0 } })
    expect(result).toEqual({
      ok: false,
      error: { code: 'session-not-found', message: 'no such session', details: { sessionId: 'x' } },
    })
  })

  it('folds a non-2xx HTTP status into an http error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)))
    const result = await callUnary<unknown>('session/list', { _request: {} })
    expect(result).toEqual({ ok: false, error: { code: 'http', message: 'HTTP 500' } })
  })

  it('folds a network failure into a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await callUnary<unknown>('session/list', { _request: {} })
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'transport failed: network down' } })
  })

  it('bounds a never-resolving fetch with the unary timeout', async () => {
    // A fetch that never settles but honors the abort signal: over a remote link
    // a dropped response must fold to a transport error, not hang forever.
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })))
    const pending = callUnary<unknown>('session/rename', { request: { sessionId: 's1', title: 'x' } }, undefined, 25)
    const result = await Promise.race([
      pending,
      new Promise<{ timeout: true }>((resolve) => { setTimeout(() => { resolve({ timeout: true }) }, 500) }),
    ])
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'transport failed: aborted' } })
  })

  it('rejects a response envelope with a mismatched rpcId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ type: 'server-response', rpcId: 'other', result: { ok: true, value: 1 } })))
    const result = await callUnary<unknown>('session/list', { _request: {} })
    expect(result).toEqual({ ok: false, error: { code: 'transport', message: 'response envelope mismatch' } })
  })

  it('folds a non-JSON response body into a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } } as unknown as Response)))
    const result = await callUnary<unknown>('session/list', { _request: {} })
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

describe('parseMuxFrame', () => {
  it('parses item, end, and error server frames', () => {
    expect(parseMuxFrame(JSON.stringify({ type: 'item', streamId: 'f1', value: { a: 1 } })))
      .toEqual({ type: 'item', streamId: 'f1', value: { a: 1 } })
    expect(parseMuxFrame(JSON.stringify({ type: 'item', streamId: 'f1' })))
      .toEqual({ type: 'item', streamId: 'f1', value: undefined })
    expect(parseMuxFrame(JSON.stringify({ type: 'end', streamId: 'f1' })))
      .toEqual({ type: 'end', streamId: 'f1' })
    expect(parseMuxFrame(JSON.stringify({
      type: 'error',
      streamId: 'f1',
      error: { code: 'session-not-found', message: 'no such session', details: {} },
    }))).toEqual({
      type: 'error',
      streamId: 'f1',
      error: { code: 'session-not-found', message: 'no such session', details: {} },
    })
  })

  it('drops non-JSON, unknown, and malformed frames', () => {
    expect(parseMuxFrame('not json')).toBeUndefined()
    expect(parseMuxFrame(JSON.stringify({ type: 'other' }))).toBeUndefined()
    expect(parseMuxFrame(JSON.stringify({ type: 'item' }))).toBeUndefined()
    expect(parseMuxFrame(JSON.stringify({ type: 'error', streamId: 'f1' }))).toBeUndefined()
    expect(parseMuxFrame(42)).toBeUndefined()
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
  const sent: string[] = []
  const socket = {
    get onopen() { return handlers.onopen },
    set onopen(value) { handlers.onopen = value },
    get onmessage() { return handlers.onmessage },
    set onmessage(value) { handlers.onmessage = value },
    get onerror() { return handlers.onerror },
    set onerror(value) { handlers.onerror = value },
    get onclose() { return handlers.onclose },
    set onclose(value) { handlers.onclose = value },
    send: (data: string) => { sent.push(data) },
    close,
  } satisfies WebSocketLike
  return { socket, handlers, sent, close }
}

/** The `open` client message sent for one observed session's follow stream. */
function followOpen(sent: string[]): { type: string; streamId: string; endpoint: string; payload: unknown } {
  const opens = sent.map(data => JSON.parse(data) as { type: string; streamId: string; endpoint: string; payload: unknown })
    .filter(message => message.type === 'open')
  expect(opens.length).toBeGreaterThan(0)
  return opens.at(-1)!
}

const chunkEvent = (seq: number, text: string): unknown => ({
  type: 'assistant/chunk',
  seq,
  time: seq,
  data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text } },
})

function snapshotValue(cursor: number, hasMore: boolean): unknown {
  return {
    type: 'snapshot',
    header: { id: 's1' },
    cursor,
    hasMore,
    projections: { asOfSeq: cursor, values: { title: 'T' } },
    records: [{ type: 'event', event: chunkEvent(1, 'hi') }],
  }
}

describe('EventsClient', () => {
  it('exposes the same-origin remote-mux URL', () => {
    expect(muxUrl()).toBe(`ws://${window.location.host}/api/remote.mux`)
  })

  it('opens a session/follow stream for the observed session and fans snapshot records out', async () => {
    const { socket, handlers, sent } = fakeSocket()
    const snapshots: SessionSnapshotFrame[] = []
    const frames: { sessionId: string; seq: number }[] = []
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory: () => socket, idleTimeoutMs: 0 })
    client.onSnapshot((snapshot) => { snapshots.push(snapshot) })
    client.onFrame((frame) => { frames.push({ sessionId: frame.sessionId, seq: frame.event.seq }) })
    client.observe('s1')
    client.start()
    handlers.onopen?.(undefined)

    const open = followOpen(sent)
    expect(open.endpoint).toBe('session/follow')
    expect(open.payload).toEqual({
      args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 30 } },
    })

    handlers.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: open.streamId, value: snapshotValue(3, true) }) })
    await Promise.resolve()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ type: 'session/snapshot', sessionId: 's1', cursor: 3, hasMore: true })
    expect(snapshots[0]!.records).toEqual([chunkEvent(1, 'hi')])
    // Snapshot records feed the tail, not the frame fan; a late subscriber
    // still receives the held snapshot.
    const late: SessionSnapshotFrame[] = []
    client.onSnapshot((snapshot) => { late.push(snapshot) })
    expect(late).toHaveLength(1)

    handlers.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'event', event: chunkEvent(4, 'more') } }) })
    expect(frames).toEqual([{ sessionId: 's1', seq: 4 }])
    client.stop()
  })

  it('switches the follow stream with cancel + open when the observed session changes', () => {
    const { socket, handlers, sent } = fakeSocket()
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory: () => socket, idleTimeoutMs: 0 })
    client.start()
    handlers.onopen?.(undefined)
    client.observe('s1')
    expect(followOpen(sent).payload).toMatchObject({ args: { request: { address: { sessionId: 's1' } } } })
    client.observe('s2')
    const messages = sent.map(data => JSON.parse(data) as { type: string })
    expect(messages.filter(message => message.type === 'cancel')).toHaveLength(1)
    expect(followOpen(sent).payload).toMatchObject({ args: { request: { address: { sessionId: 's2' } } } })
    client.stop()
  })

  it('recycles a silently-dead socket and reconnects when no frame arrives for idleTimeoutMs', async () => {
    vi.useFakeTimers()
    const { socket, handlers, sent, close } = fakeSocket()
    const socketFactory = vi.fn(() => socket)
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory, idleTimeoutMs: 30 })
    client.start()
    handlers.onopen?.(undefined)
    client.observe('s1')

    // A delivered frame resets the watchdog: no recycle while frames flow.
    const open = followOpen(sent)
    handlers.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'event', event: chunkEvent(1, 'hi') } }) })
    await vi.advanceTimersByTimeAsync(25)
    expect(close).not.toHaveBeenCalled()

    // Silence past idleTimeoutMs: the watchdog recycles the socket, exactly as
    // if the transport had closed without a close frame.
    await vi.advanceTimersByTimeAsync(30)
    expect(close).toHaveBeenCalled()

    // The backoff schedules a reconnect through the same factory.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(socketFactory).toHaveBeenCalledTimes(2)
    client.stop()
    vi.useRealTimers()
  })

  it('recycles a socket that never opens via the connect-time watchdog', async () => {
    vi.useFakeTimers()
    const { socket, close } = fakeSocket()
    const socketFactory = vi.fn(() => socket)
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory, idleTimeoutMs: 30 })
    client.start()
    client.observe('s1')
    expect(socketFactory).toHaveBeenCalledTimes(1)

    // No onopen and no frames (a carrier swallowing the upgrade): the
    // connect-time watchdog still fires and recycles into reconnect.
    await vi.advanceTimersByTimeAsync(40)
    expect(close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(socketFactory).toHaveBeenCalledTimes(2)
    client.stop()
    vi.useRealTimers()
  })

  it('recycles on a stream error frame and reports the status transitions', async () => {
    vi.useFakeTimers()
    const { socket, handlers, sent, close } = fakeSocket()
    const statuses: string[] = []
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory: () => socket, idleTimeoutMs: 0 })
    client.onStatus((status) => { statuses.push(status) })
    client.start()
    client.observe('s1')
    handlers.onopen?.(undefined)
    expect(statuses).toEqual(['connecting', 'open'])

    handlers.onmessage?.({ data: JSON.stringify({
      type: 'error',
      streamId: followOpen(sent).streamId,
      error: { code: 'session-not-found', message: 'no such session', details: {} },
    }) })
    expect(close).toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('down')
    client.stop()
    vi.useRealTimers()
  })

  it('resume() recycles a live socket into an immediate fresh dial and follow re-open', () => {
    // One fresh fake socket per dial: resume replaces the leg, so the factory
    // must hand out a second socket for the assertions below.
    const created: ReturnType<typeof fakeSocket>[] = []
    const socketFactory = vi.fn(() => {
      const next = fakeSocket()
      created.push(next)
      return next.socket
    })
    const statuses: string[] = []
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory, idleTimeoutMs: 0 })
    client.onStatus((status) => { statuses.push(status) })
    client.start()
    client.observe('s1')
    created[0]!.handlers.onopen?.(undefined)
    expect(followOpen(created[0]!.sent).payload).toMatchObject({ args: { request: { address: { sessionId: 's1' } } } })

    client.resume()
    expect(created).toHaveLength(2)
    expect(created[0]!.close).toHaveBeenCalled()
    expect(statuses).toEqual(['connecting', 'open', 'down', 'connecting'])
    created[1]!.handlers.onopen?.(undefined)
    expect(followOpen(created[1]!.sent).payload).toMatchObject({ args: { request: { address: { sessionId: 's1' } } } })
    client.stop()
  })

  it('resume() replaces a pending backed-off dial with an immediate one', async () => {
    vi.useFakeTimers()
    const created: ReturnType<typeof fakeSocket>[] = []
    const socketFactory = vi.fn(() => {
      const next = fakeSocket()
      created.push(next)
      return next.socket
    })
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory, idleTimeoutMs: 0 })
    client.start()
    created[0]!.handlers.onopen?.(undefined)
    // A transport failure schedules the reconnect one base delay out.
    created[0]!.handlers.onerror?.(undefined)

    client.resume()
    expect(created).toHaveLength(2)
    // The cancelled backoff must not stack a second dial behind the fresh one.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(created).toHaveLength(2)
    client.stop()
    vi.useRealTimers()
  })

  it('resume() is a no-op after stop()', () => {
    const { socket } = fakeSocket()
    const socketFactory = vi.fn(() => socket)
    const client = new EventsClient('ws://x/api/remote.mux', { socketFactory, idleTimeoutMs: 0 })
    client.start()
    client.stop()
    client.resume()
    expect(socketFactory).toHaveBeenCalledTimes(1)
  })
})
