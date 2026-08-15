import { describe, expect, it, vi } from 'vitest'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { MobileApiClient } from '../src/client.ts'
import { UnauthorizedError } from '../src/errors.ts'
import { fakeFetch, jsonResponse, serverError, serverResponse, socketFactoryRig, type FakeFetch } from './helpers.client.ts'

const BASE = 'https://fake-slug.trycloudflare.com'

function clientWith(routes: FakeFetch['routes'], init?: { cookie?: string }): { client: MobileApiClient; fetch: FakeFetch } {
  const fetch = fakeFetch()
  for (const [path, handler] of routes) fetch.routes.set(path, handler)
  const client = new MobileApiClient({ baseUrl: BASE, cookie: init?.cookie ?? 'cookie-1', fetchImpl: fetch.impl })
  return { client, fetch }
}

describe('MobileApiClient', () => {
  it('sends the envelope to /api/<method> with the session cookie and echoes the rpcId', async () => {
    const { client, fetch } = clientWith(new Map([
      ['/api/session.list', (init) => {
        const body = JSON.parse(init?.body as string) as { rpcId: string }
        return jsonResponse(serverResponse(body.rpcId, { items: [] }))
      }],
    ]))
    const result = await client.sessions.list({})
    expect(result.result).toEqual({ ok: true, value: { items: [] } })
    const call = fetch.calls[0]!
    expect(new URL(call.url).href).toBe(BASE + '/api/session.list')
    const headers = new Headers(call.init?.headers)
    expect(headers.get('cookie')).toBe('dsh_remote=cookie-1')
    expect(headers.get('content-type')).toBe('application/json')
    const body = JSON.parse(call.init?.body as string) as { type: string; method: string; rpcId: string }
    expect(body).toMatchObject({ type: 'client-request', method: 'session.list' })
    expect(body.rpcId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('returns a business error result without throwing', async () => {
    const { client } = clientWith(new Map([
      ['/api/session.list', (init) => {
        const body = JSON.parse(init?.body as string) as { rpcId: string }
        return jsonResponse(serverError(body.rpcId, 'sessions are sad', 'internal'))
      }],
    ]))
    const result = await client.sessions.list({})
    expect(result.result).toMatchObject({ ok: false, error: { code: 'internal', message: 'sessions are sad' } })
  })

  it('brands 401 as UnauthorizedError', async () => {
    const { client } = clientWith(new Map([
      ['/api/session.list', () => new Response('pairing hint', { status: 401 })],
    ]))
    await expect(client.sessions.list({})).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it('throws a transport failure on other non-ok statuses', async () => {
    const { client } = clientWith(new Map([
      ['/api/session.list', () => new Response('gone', { status: 410 })],
    ]))
    await expect(client.sessions.list({})).rejects.toThrow(/HTTP 410/)
  })

  it('rejects a response that fails the business value schema', async () => {
    const { client } = clientWith(new Map([
      ['/api/session.list', (init) => {
        const body = JSON.parse(init?.body as string) as { rpcId: string }
        return jsonResponse(serverResponse(body.rpcId, { items: 'not-an-array' }))
      }],
    ]))
    await expect(client.sessions.list({})).rejects.toThrow()
  })

  it('rejects a response whose rpcId does not echo the request', async () => {
    const { client } = clientWith(new Map([
      ['/api/session.list', () => jsonResponse(serverResponse('someone-else', { items: [] }))],
    ]))
    await expect(client.sessions.list({})).rejects.toThrow(/rpcId mismatch/)
  })

  it('opens the mux WebSocket with the cookie header and yields parsed frames until close', async () => {
    const rig = socketFactoryRig()
    const client = new MobileApiClient({ baseUrl: BASE, cookie: 'cookie-1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const frames: RpcRequest<MuxFrame>[] = []
    const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    rig.sockets[0]!.open()
    rig.sockets[0]!.push({ type: 'stream/heartbeat' }, 'f1')
    rig.sockets[0]!.push({ type: 'session/subscribed', sessionId: 's1', lastSeq: 3 }, 'f2')
    rig.sockets[0]!.close()
    frames.push((await first).value as RpcRequest<MuxFrame>)
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.done) break
      frames.push(next.value)
    }
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ rpcId: 'f1', payload: { type: 'stream/heartbeat' } })
    expect(frames[1]).toMatchObject({ rpcId: 'f2', payload: { type: 'session/subscribed', sessionId: 's1' } })
    expect(rig.calls[0]!.url).toBe('wss://fake-slug.trycloudflare.com/api/events.mux')
    expect(rig.calls[0]!.headers).toEqual({ cookie: 'dsh_remote=cookie-1' })
  })

  it('drops non-text and malformed socket frames without killing the stream', async () => {
    const rig = socketFactoryRig()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = rig.sockets[0]
    if (socket === undefined) throw new Error('no socket')
    socket.open()
    socket.push('garbage-not-json', 'f1')
    socket.push({ type: 'stream/heartbeat' }, 'f2')
    socket.emitMessage(new Uint8Array([1, 2, 3]))
    socket.close()
    expect((await first).value).toEqual({ rpcId: 'f2', payload: { type: 'stream/heartbeat' } })
    if (iterator.return !== undefined) await iterator.return()
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('falls back to the global fetch when no implementation is injected', async () => {
    const global = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { rpcId: string }
      return jsonResponse(serverResponse(body.rpcId, { items: [] }))
    })
    vi.stubGlobal('fetch', global)
    try {
      const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1' })
      const result = await client.sessions.list({})
      expect(result.result).toEqual({ ok: true, value: { items: [] } })
      expect(global).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('defaults to the platform WebSocket constructor with headers as the third argument', async () => {
    const rig = socketFactoryRig()
    const captured: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('WebSocket', function WebSocketStub(url: string, _protocols: unknown, options: { headers: Record<string, string> }) {
      captured.push({ url, headers: options.headers })
      return rig.factory(url, options.headers)
    })
    try {
      const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl })
      const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
      const first = iterator.next()
      rig.sockets[0]!.open()
      rig.sockets[0]!.push({ type: 'stream/heartbeat' })
      rig.sockets[0]!.close()
      await first
      expect(captured).toEqual([{ url: 'wss://fake-slug.trycloudflare.com/api/events.mux', headers: { cookie: 'dsh_remote=c1' } }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses ws:// for http origins', async () => {
    const rig = socketFactoryRig()
    const client = new MobileApiClient({ baseUrl: 'http://host.example:3080', cookie: 'c1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    rig.sockets[0]!.open()
    rig.sockets[0]!.close()
    await first
    expect(rig.calls[0]!.url).toBe('ws://host.example:3080/api/events.mux')
  })

  it('tolerates socket error events and keeps delivering frames', async () => {
    const rig = socketFactoryRig()
    const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = rig.sockets[0]!
    socket.open()
    socket.emitError()
    socket.push({ type: 'stream/heartbeat' }, 'f1')
    socket.close()
    expect((await first).value).toEqual({ rpcId: 'f1', payload: { type: 'stream/heartbeat' } })
  })

  it('opens the host stream over /api/events.host', async () => {
    const rig = socketFactoryRig()
    const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const iterator = client.events.host({}, new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    rig.sockets[0]!.open()
    rig.sockets[0]!.push({ type: 'host/session-status', sessionId: 's1', running: false }, 'h1')
    rig.sockets[0]!.close()
    expect((await first).value).toEqual({ rpcId: 'h1', payload: { type: 'host/session-status', sessionId: 's1', running: false } })
    expect(rig.calls[0]!.url).toBe('wss://fake-slug.trycloudflare.com/api/events.host')
  })

  it('closes the socket immediately when the signal is already aborted', async () => {
    const rig = socketFactoryRig()
    const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl, openSocket: (url, headers) => rig.factory(url, headers) })
    const aborted = new AbortController()
    aborted.abort()
    const iterator = client.events.mux({}, aborted.signal)[Symbol.asyncIterator]()
    const result = await iterator.next()
    expect(result.done).toBe(true)
    expect(result.value).toBeUndefined()
  })

  it('fails loudly when no WebSocket implementation exists', async () => {
    vi.stubGlobal('WebSocket', undefined)
    try {
      const client = new MobileApiClient({ baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl })
      const iterator = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toThrow(/no WebSocket implementation/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
