import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installConnection,
  type ConnectionGenerationSource,
  type ConnectionHandle,
} from '../src/client/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all([...contexts].map(async ctx => ctx.fiber.dispose()))
  contexts.clear()
})

function mount(networkInfo: EventTarget & { type?: string; effectiveType?: string; rtt?: number }): ConnectionHandle {
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const windowTarget = Object.assign(new EventTarget(), {
    navigator: { onLine: true, connection: networkInfo },
    document: documentTarget,
  })
  vi.stubGlobal('window', windowTarget)
  const ctx = new Context()
  contexts.add(ctx)
  installConnection(ctx, {
    location: { hostname: 'harness.example' },
    transport: { rpc: { call: vi.fn<ConnectionHandle['rpc']['call']>() } },
  })
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('plugin did not provide Connection')
  return connection
}

function source(started: ReturnType<typeof vi.fn<() => void>>): ConnectionGenerationSource {
  return (signal, ready) => {
    started()
    ready({ home: '/home/remote' })
    return new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
}

async function start(connection: ConnectionHandle, started: ReturnType<typeof vi.fn<() => void>>) {
  const reconnected = vi.fn<() => void>()
  const loop = connection.start(
    { onReconnectRequested: reconnected },
    { backoffBaseMs: 1, backoffFactor: 1, backoffMaxMs: 1, generationReadyTimeoutMs: 100 },
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(started).toHaveBeenCalledTimes(1)
  return { loop, reconnected }
}

describe('browser network changes', () => {
  it('does not reconnect when only the RTT estimate changes', async () => {
    vi.useFakeTimers()
    const info = Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g', rtt: 50 })
    const connection = mount(info)
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))
    const { loop, reconnected } = await start(connection, started)

    info.rtt = 650
    info.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(1_500)

    expect(reconnected).not.toHaveBeenCalled()
    expect(started).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('debounces a real effective-type change into one reconnect', async () => {
    vi.useFakeTimers()
    const info = Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g', rtt: 50 })
    const connection = mount(info)
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))
    const { loop, reconnected } = await start(connection, started)

    info.effectiveType = '3g'
    info.dispatchEvent(new Event('change'))
    info.rtt = 650
    info.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(1_500)

    expect(reconnected).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('keeps the legacy reconnect fallback when carrier fields are unavailable', async () => {
    vi.useFakeTimers()
    const info = new EventTarget() as EventTarget & { type?: string; effectiveType?: string; rtt?: number }
    const connection = mount(info)
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))
    const { loop, reconnected } = await start(connection, started)

    info.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(1_500)

    expect(reconnected).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('restarts the debounce when a second real switch arrives inside the window', async () => {
    // A radio transition reports several changes as it re-associates. Only the
    // last one describes the carrier the page will use, so the timer restarts
    // rather than firing for the intermediate state.
    vi.useFakeTimers()
    const info = Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g', rtt: 50 })
    const connection = mount(info)
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))
    const { loop, reconnected } = await start(connection, started)

    info.effectiveType = '3g'
    info.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(1_000)
    // The first timer is still pending; this second change replaces it.
    info.type = 'cellular'
    info.dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(600)

    expect(reconnected).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(reconnected).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it('installs no network watch when the page cannot report network state', async () => {
    // A non-browser composition has no window: nothing to watch, and no
    // handler left behind that could reconnect a loop nobody observes.
    vi.stubGlobal('window', undefined)
    const ctx = new Context()
    contexts.add(ctx)
    installConnection(ctx, {
      location: { hostname: 'harness.example' },
      transport: { rpc: { call: vi.fn<ConnectionHandle['rpc']['call']>() } },
    })
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('plugin did not provide Connection')
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))

    const loop = connection.start({}, { generationReadyTimeoutMs: 100 })
    await vi.waitFor(() => { expect(started).toHaveBeenCalledTimes(1) })
    loop.stop()

    expect(connection.isLoopback).toBe(false)
  })

  it('cancels a pending switch when the connection loop stops', async () => {
    // Stopping the loop withdraws its network watch; a debounce still pending at
    // that moment must not fire afterwards and reconnect a loop nobody owns.
    vi.useFakeTimers()
    const info = Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g', rtt: 50 })
    const connection = mount(info)
    const started = vi.fn<() => void>()
    connection.registerGenerationSource(source(started))
    const { loop, reconnected } = await start(connection, started)

    info.effectiveType = '3g'
    info.dispatchEvent(new Event('change'))
    loop.stop()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(reconnected).not.toHaveBeenCalled()
  })

  it('opens a socket through the installed transport factory', () => {
    // The handle owns the carrier factory, so a caller never reaches the
    // browser WebSocket directly and the shell-provided factory stays in use.
    vi.stubGlobal('window', undefined)
    const opened = vi.fn<() => void>()
    const ctx = new Context()
    contexts.add(ctx)
    installConnection(ctx, {
      location: { hostname: 'harness.example' },
      transport: {
        rpc: { call: vi.fn<ConnectionHandle['rpc']['call']>() },
        streamBaseUrl: 'https://harness.example/',
        createWebSocket: () => {
          opened()
          throw new Error('fixture socket factory reached')
        },
      },
    })
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('plugin did not provide Connection')

    expect(() => connection.openWebSocket('/api/mux')).toThrow('fixture socket factory reached')
    expect(opened).toHaveBeenCalledOnce()
  })
})
