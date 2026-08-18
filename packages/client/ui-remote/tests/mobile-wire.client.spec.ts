// @vitest-environment jsdom
/** Mobile wire layer: unary RPC envelope + error folding, rpcId minting, and mux frame parsing. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callUnary, mintRpcId } from '../src/mobile/rpc.ts'
import { parseFrame } from '../src/mobile/events.ts'

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
