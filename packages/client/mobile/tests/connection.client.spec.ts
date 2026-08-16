import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileApiClient } from '../src/client.ts'
import { MobileConnection } from '../src/connection.ts'
import type { ConnectionStatus } from '../src/types.ts'
import { fakeFetch, socketFactoryRig, type SocketMock } from './helpers.client.ts'

const BASE = 'https://fake-slug.trycloudflare.com'

interface Rig {
  connection: MobileConnection
  sockets: SocketMock[]
  frames: unknown[]
  statuses: ConnectionStatus[]
  freshSocket(): SocketMock
}

/** A connection whose socket factory records one scriptable socket per attempt, auto-opened on a microtask. */
function rig(options: { maxAttempts?: number; idleTimeoutMs?: number } = {}): Rig {
  const socketRig = socketFactoryRig()
  const sockets: SocketMock[] = []
  const statuses: ConnectionStatus[] = []
  const frames: unknown[] = []
  const connection = new MobileConnection({
    client: new MobileApiClient({
      baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl,
      openSocket: (url, headers) => {
        const socket = socketRig.factory(url, headers)
        sockets.push(socket)
        queueMicrotask(() => { socket.open() })
        return socket
      },
    }),
    callbacks: {
      onStatus: (status) => { statuses.push(status) },
      onFrame: (envelope) => { frames.push(envelope.payload) },
    },
    ...options,
  })
  return { connection, sockets, frames, statuses, freshSocket: () => sockets[sockets.length - 1]! }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MobileConnection', () => {
  it('opens the stream, publishes online, and delivers frames', async () => {
    const r = rig()
    r.connection.start()
    await vi.waitFor(() => { expect(r.sockets).toHaveLength(1) })
    await vi.waitFor(() => { expect(r.statuses).toContain('online') })
    r.freshSocket().push({ type: 'stream/heartbeat' }, 'f1')
    await vi.waitFor(() => { expect(r.frames).toEqual([{ type: 'stream/heartbeat' }]) })
    r.connection.stop()
    // The initial 'connecting' state is the connection's own birth state and
    // is not republished; the first published transition is 'online'.
    expect(r.statuses[0]).toBe('online')
  })

  it('reconnects with linear backoff after a clean end and resets on success', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(1)
    r.freshSocket().close()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.statuses).toContain('reconnecting')
    // First retry after step * attempt 1.
    await vi.advanceTimersByTimeAsync(500)
    expect(r.sockets).toHaveLength(2)
    r.freshSocket().close()
    await vi.advanceTimersByTimeAsync(0)
    // The successful open reset the budget, so the next retry again costs one step.
    await vi.advanceTimersByTimeAsync(500)
    expect(r.sockets).toHaveLength(3)
    r.connection.stop()
  })

  it('retries when the socket factory itself throws', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const statuses: ConnectionStatus[] = []
    const connection = new MobileConnection({
      client: new MobileApiClient({
        baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl,
        openSocket: () => {
          throw new Error('no socket implementation')
        },
      }),
      callbacks: { onStatus: (status) => { statuses.push(status) }, onFrame: () => undefined },
      maxAttempts: 2,
      backoffStepMs: 10,
    })
    connection.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(statuses.at(-1)).toBe('failed')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('lands on failed after the attempt budget is spent', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sockets: SocketMock[] = []
    const statuses: ConnectionStatus[] = []
    const connection = new MobileConnection({
      client: new MobileApiClient({
        baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl,
        openSocket: () => {
          const socket = socketFactoryRig()
          // The server side never accepts: the socket dies unopened.
          const mock = socket.factory('wss://x/api/events.mux', { cookie: 'c1' })
          sockets.push(mock)
          queueMicrotask(() => { mock.close() })
          return mock
        },
      }),
      callbacks: { onStatus: (status) => { statuses.push(status) }, onFrame: () => undefined },
      maxAttempts: 2,
      backoffStepMs: 10,
    })
    connection.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(statuses.at(-1)).toBe('failed')
    expect(sockets).toHaveLength(3)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })

  it('reconnects when the stream stays quiet past the idle watchdog', async () => {
    vi.useFakeTimers()
    const r = rig({ idleTimeoutMs: 45_000 })
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.statuses).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    expect(r.sockets).toHaveLength(2)
    r.connection.stop()
  })

  it('delivered frames keep the idle watchdog at bay', async () => {
    vi.useFakeTimers()
    const r = rig({ idleTimeoutMs: 45_000 })
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 3; index++) {
      r.freshSocket().push({ type: 'stream/heartbeat' }, 'f' + String(index))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(44_000)
    }
    expect(r.sockets).toHaveLength(1)
    expect(r.statuses).not.toContain('reconnecting')
    // Quiet past the deadline: the watchdog fires and the loop reconnects.
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.statuses).toContain('reconnecting')
    r.connection.stop()
  })

  it('a disabled idle watchdog never aborts a quiet stream', async () => {
    vi.useFakeTimers()
    const r = rig({ idleTimeoutMs: 0 })
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(120_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(1)
    expect(r.statuses).not.toContain('reconnecting')
    r.connection.stop()
  })

  it('ignores a second start while the pump is already running', async () => {
    const r = rig()
    r.connection.start()
    await vi.waitFor(() => { expect(r.sockets).toHaveLength(1) })
    r.connection.start()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(r.sockets).toHaveLength(1)
    r.connection.stop()
  })

  it('aborts the open stream on stop without retrying', async () => {
    const r = rig()
    r.connection.start()
    await vi.waitFor(() => { expect(r.sockets).toHaveLength(1) })
    r.connection.stop()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(r.sockets).toHaveLength(1)
    expect(r.statuses).not.toContain('reconnecting')
  })

  it('a clean end racing stop does not schedule a retry', async () => {
    const r = rig()
    r.connection.start()
    await vi.waitFor(() => { expect(r.sockets).toHaveLength(1) })
    r.freshSocket().close()
    // Stop in the same tick as the close: the pump resumes on a microtask and
    // finds itself stopped before scheduling the retry.
    r.connection.stop()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(r.sockets).toHaveLength(1)
    expect(r.statuses).not.toContain('reconnecting')
  })

  it('a pump superseded by stop-then-start does not open a competing stream', async () => {
    vi.useFakeTimers()
    const r = rig()
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(1)
    // End the stream, then restart before the dying pump resumes: it must not
    // adopt the fresh generation and keep reconnecting beside the new pump.
    r.freshSocket().close()
    r.connection.stop()
    r.connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.sockets).toHaveLength(2)
    expect(r.statuses).not.toContain('reconnecting')
    r.connection.stop()
  })

  it('restarts with a fresh budget after stop and start', async () => {
    vi.useFakeTimers()
    const sockets: SocketMock[] = []
    const statuses: ConnectionStatus[] = []
    const connection = new MobileConnection({
      client: new MobileApiClient({
        baseUrl: BASE, cookie: 'c1', fetchImpl: fakeFetch().impl,
        openSocket: (_url, _headers) => {
          const socket = socketFactoryRig()
          const mock = socket.factory('wss://x/api/events.mux', { cookie: 'c1' })
          sockets.push(mock)
          queueMicrotask(() => { mock.open() })
          return mock
        },
      }),
      callbacks: { onStatus: (status) => { statuses.push(status) }, onFrame: () => undefined },
      maxAttempts: 2,
      backoffStepMs: 10,
    })
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.close()
    await vi.advanceTimersByTimeAsync(0)
    connection.stop()
    const seen = [...statuses]
    connection.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    expect(seen).toContain('reconnecting')
    // The stale pump's backoff timer fires and its generation guard stops it
    // from opening a second stream beside the fresh pump.
    await vi.advanceTimersByTimeAsync(20)
    expect(sockets).toHaveLength(2)
    connection.stop()
    vi.useRealTimers()
  })
})
