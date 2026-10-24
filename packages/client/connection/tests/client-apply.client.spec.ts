/**
 * Connection plugin browser-half apply: ctx.connection handle mounting,
 * explicit carrier selection, and single-consumer connection-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ClientConnectionRpc,
  type ClientTransportHooks,
  type ConnectionGenerationSource,
  type RpcFetch,
  type ConnectionHandle,
  type ConnectionState,
} from '../src/client/index.ts'

type Win = {
  location?: { hostname: string; origin?: string }
  __DSH_TRANSPORT__?: ClientTransportHooks
}

afterEach(() => {
  delete (globalThis as Win).location
  delete (globalThis as Win).__DSH_TRANSPORT__
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class BrowserPageProbe extends EventTarget {
  visibilityState = 'visible'

  becomeVisible(): void {
    this.visibilityState = 'visible'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

/** Stand-in for the Network Information API's `navigator.connection`. */
type NetworkInformationProbe = EventTarget & {
  addEventListener: EventTarget['addEventListener']
  removeEventListener: EventTarget['removeEventListener']
}

class BrowserNetworkProbe extends EventTarget {
  readonly navigator: { onLine: boolean; connection?: NetworkInformationProbe } = {
    onLine: true,
  }
  readonly document = new BrowserPageProbe()

  /** Install a Network Information probe, as a Chrome-family browser does. */
  installNetworkInformation(): NetworkInformationProbe {
    const info: NetworkInformationProbe = new EventTarget()
    this.navigator.connection = info
    return info
  }

  setOnline(online: boolean): void {
    this.navigator.onLine = online
    this.dispatchEvent(new Event(online ? 'online' : 'offline'))
  }

  /**
   * Flip the browser's verdict without delivering its event: what a phone leaves
   * behind when it freezes the page across the radio's transitions.
   * @param online - verdict the browser now reports.
   */
  setOnlineSilently(online: boolean): void {
    this.navigator.onLine = online
  }
}

class GenerationProbe {
  private readonly active = new Set<() => void>()

  readonly source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', finish)
      this.active.delete(finish)
      resolve()
    }
    this.active.add(finish)
    signal.addEventListener('abort', finish, { once: true })
    ready({ home: '/h' })
    if (signal.aborted) finish()
  })

  end(): void {
    for (const finish of [...this.active]) finish()
  }
}

function installGeneration(handle: ConnectionHandle): GenerationProbe {
  const probe = new GenerationProbe()
  handle.registerGenerationSource(probe.source)
  return probe
}

/**
 * Start one loop whose generation source counts attempts, so a test can tell a
 * resumed retry from a parked loop.
 * @param handle - installed Connection handle owning the loop.
 * @returns the loop controls and the current attempt count.
 */
function startCountingLoop(handle: ConnectionHandle): {
  loop: ReturnType<ConnectionHandle['start']>
  calls: () => number
} {
  const counter = { count: 0 }
  handle.registerGenerationSource((signal, ready) => {
    counter.count++
    ready({ home: '/h' })
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })
  const loop = handle.start({}, {
    backoffBaseMs: 100,
    backoffFactor: 2,
    backoffMaxMs: 1_000,
    generationReadyTimeoutMs: 500,
  })
  return { loop, calls: () => counter.count }
}

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('uses Host bootstrap timing when Gateway starts without overrides', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('__DSH_CONNECTION_RECOVERY__', {
      backoffBaseMs: 10, backoffMaxMs: 10, generationReadyTimeoutMs: 20,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handle = await mount()
    const signals: AbortSignal[] = []
    handle.registerGenerationSource(signal => new Promise<void>((resolve) => {
      signals.push(signal)
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    }))
    const loop = handle.start({})
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(signals[0]?.aborted).toBe(true)
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(10)
      expect(signals).toHaveLength(2)
    } finally {
      loop.stop()
      await vi.advanceTimersByTimeAsync(0)
      warnSpy.mockRestore()
    }
  })

  it.each([{ generationReadyTimeoutMs: 0 }, { backoffFactor: NaN }])('rejects malformed bootstrap recovery before publishing the service: %j', (recovery) => {
    vi.stubGlobal('__DSH_CONNECTION_RECOVERY__', recovery)
    const ctx = new Context()
    expect(() => { apply(ctx) }).toThrow()
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('rejects a NaN start override without acquiring the generation source', async () => {
    const handle = await mount()
    const source = vi.fn<ConnectionGenerationSource>()
    const unregister = handle.registerGenerationSource(source)
    try {
      expect(() => handle.start({}, { backoffFactor: NaN })).toThrow(/backoffFactor.*finite/)
      expect(source).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('treats a runtime without browser location as local', async () => {
    delete (globalThis as Win).location
    expect((await mount()).isLoopback).toBe(true)
  })

  it('mounts ctx.connection and identifies a loopback page', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('requires one generation source and ignores a stale source disposer', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const first = new GenerationProbe()
    const second = new GenerationProbe()

    expect(() => handle.start({})).toThrow('no generation source is registered')
    const unregisterFirst = handle.registerGenerationSource(first.source)
    expect(() => { handle.registerGenerationSource(second.source) })
      .toThrow('a generation source is already registered')
    unregisterFirst()
    const unregisterSecond = handle.registerGenerationSource(second.source)
    unregisterFirst()

    const loop = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    unregisterSecond()
    expect(handle.generation.getSnapshot()).toBeUndefined()
    loop.stop()
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    installGeneration(handle)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generations: Array<string | undefined> = []
    const stopThrowing = handle.generation.subscribe(() => { throw new Error('subscriber bug') })
    const stopGeneration = handle.generation.subscribe(() => {
      generations.push(handle.generation.getSnapshot()?.host.home)
    })
    expect(handle.generation.getSnapshot()).toBeUndefined()
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.generation.getSnapshot()).toBeUndefined()
    expect(generations).toEqual(['/h', undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopGeneration()
    errorSpy.mockRestore()
  })

  it('does not notify state subscribers when a pre-ready loop stops', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    handle.registerGenerationSource(signal => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    }))
    const listener = vi.fn()
    const unsubscribe = handle.state.subscribe(listener)
    const loop = handle.start({})

    loop.stop()

    expect(handle.state.getSnapshot()).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('allows a replacement owner and ignores the previous owner handle', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const generation = installGeneration(handle)

    const first = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    first.stop()
    expect(handle.generation.getSnapshot()).toBeUndefined()

    const second = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    first.stop()
    expect(handle.generation.getSnapshot()?.host.home).toBe('/h')

    second.stop()
    generation.end()
  })

  it('lets the connection service force only its current owner to reconnect', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    installGeneration(handle)
    const requested = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({ onReconnectRequested: requested }, {
      backoffBaseMs: 60_000,
      backoffFactor: 2,
      backoffMaxMs: 120_000,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.waitFor(() => { expect(handle.generation.getSnapshot()?.id).toBe(1) })
      handle.reconnect()
      await vi.waitFor(() => { expect(handle.generation.getSnapshot()?.id).toBe(2) })
      expect(requested).toHaveBeenCalledOnce()
      loop.stop()
      handle.reconnect()
      expect(requested).toHaveBeenCalledOnce()
    } finally {
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('ignores a non-browser window shim without navigator state', async () => {
    vi.stubGlobal('window', new EventTarget())
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    installGeneration(handle)
    const loop = handle.start({})
    try {
      await vi.waitFor(() => { expect(handle.state.getSnapshot()).toBe('connected') })
    } finally {
      loop.stop()
    }
  })

  it('feeds browser offline and online events into the owned retry loop', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    let calls = 0
    const source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
      calls++
      ready({ home: '/h' })
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    handle.registerGenerationSource(source)
    const states: Array<ConnectionState | undefined> = []
    const unsubscribe = handle.state.subscribe(() => { states.push(handle.state.getSnapshot()) })
    const loop = handle.start({}, {
      backoffBaseMs: 100,
      backoffFactor: 2,
      backoffMaxMs: 1_000,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(handle.state.getSnapshot()).toBe('connected')
      expect(calls).toBe(1)

      browser.setOnline(false)
      expect(handle.state.getSnapshot()).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toBe(1)

      browser.setOnline(true)
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(49)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')
      expect(states).toEqual(['connected', 'disconnected', 'connecting', 'connected'])
    } finally {
      unsubscribe()
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('re-reads the browser verdict on foreground return and resumes retries after a missed online event', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)

      // The page is backgrounded while the radio drops: Chrome delivers offline,
      // then the OS freezes the page. The radio returns during the freeze, so the
      // matching online event is never delivered to this page.
      browser.setOnline(false)
      expect(handle.state.getSnapshot()).toBe('disconnected')
      browser.setOnlineSilently(true)

      // A visibilitychange while the page is still hidden must not resume work.
      browser.document.visibilityState = 'hidden'
      browser.document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('disconnected')

      // The foreground return re-reads the live verdict and restarts the sequence.
      browser.document.becomeVisible()
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(49)
      expect(calls()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls()).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')

      // A foreground return while the verdict is still offline earns exactly one
      // forced attempt: a 'false' the page never saw change is as likely to be a
      // verdict frozen across the suspension as a real outage, and waiting for an
      // online event that was delivered to a frozen page never ends the stall.
      browser.setOnline(false)
      browser.document.becomeVisible()
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(100)
      expect(calls()).toBe(3)
      // The probe source always becomes ready, so this attempt lands; a real
      // offline radio fails it and the loop parks until the online transition.
      expect(handle.state.getSnapshot()).toBe('connected')
      // The browser's own online event still recovers the loop.
      browser.setOnline(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(calls()).toBe(4)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('resumes retries when a restored page reports visible through pageshow', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)

      // A bfcache restore delivers pageshow instead of a visibilitychange on the
      // live document, and the radio returned while the page was in the cache.
      browser.setOnline(false)
      browser.setOnlineSilently(true)
      expect(handle.state.getSnapshot()).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBe(1)

      browser.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(100)
      expect(calls()).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('reconnects when the browser reports an effective-connection change without an offline gap', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    const info = browser.installNetworkInformation()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)

      // The phone moved between cellular and Wi-Fi: the browser never went
      // offline, but every socket on the old leg is now dead. The interrupt
      // waits out the burst a radio transition produces, so nothing has
      // happened yet.
      info.dispatchEvent(new Event('change'))
      await vi.advanceTimersByTimeAsync(500)
      expect(handle.state.getSnapshot()).toBe('connected')
      expect(calls()).toBe(1)
      // Past the debounce window: the last transition of the burst is current.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('interrupts once for a burst of effective-connection changes', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    const info = browser.installNetworkInformation()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)

      // Android reports several transitions while it re-associates. Each one
      // used to abort a generation that had already started recovering, so a
      // single background trip could churn the carrier indefinitely.
      for (let index = 0; index < 12; index += 1) {
        info.dispatchEvent(new Event('change'))
        await vi.advanceTimersByTimeAsync(250)
      }
      expect(calls()).toBe(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('forces one attempt when a returning page still reports offline, then waits for the radio', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: '192.0.2.20' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)

      // The phone suspends and the radio drops; the page never sees the event.
      browser.document.visibilityState = 'hidden'
      browser.document.dispatchEvent(new Event('visibilitychange'))
      browser.setOnlineSilently(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls()).toBe(1)

      // It returns while the radio is still re-associating. The re-read finds the
      // same 'false' the controller already holds, so only the forced attempt can
      // end the stall — without it this page never connects again.
      browser.document.visibilityState = 'visible'
      browser.document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls()).toBe(2)

      // The verdict is still false, so the loop parks again instead of burning
      // attempts against a radio the browser says is gone.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls()).toBe(2)

      // The real transition resumes normal retry from the 500ms tier.
      browser.setOnline(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBeGreaterThan(2)
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('ignores radio transitions on a loopback page, whose Host the browser network path does not carry', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    const info = browser.installNetworkInformation()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('connected')

      // The laptop moves between Wi-Fi and Ethernet, or the estimator revises the
      // effective connection type: the loopback leg stayed up throughout.
      info.dispatchEvent(new Event('change'))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('connected')

      // A radio drop is equally unrelated to a Host reached over loopback.
      browser.setOnline(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(handle.state.getSnapshot()).toBe('connected')
      browser.setOnline(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('ignores radio transitions on a shell-owned Host page whose authority is not loopback', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    const info = browser.installNetworkInformation()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: 'app' }
    // The desktop shell serves its page from dsh-app://app and dials the Host it
    // spawned on loopback, so the authority is not loopback but the leg is.
    ;(globalThis as Win).__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:3080' }
    const handle = await mount()
    expect(handle.isLoopback).toBe(true)
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)
      info.dispatchEvent(new Event('change'))
      browser.setOnline(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('starts a loopback page whose browser reports no network at load time', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    // The API is already unreachable from a plain browser context, so the
    // loopback Host answers regardless of what the radio reports.
    browser.navigator.onLine = false
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const { loop, calls } = startCountingLoop(handle)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(1)
      expect(handle.state.getSnapshot()).toBe('connected')
    } finally {
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('does not announce a generation synchronously stopped by a generation subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawGeneration = false
    const stopGeneration = handle.generation.subscribe(() => {
      if (handle.generation.getSnapshot() === undefined) return
      sawGeneration = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawGeneration).toBe(true) })
      expect(handle.generation.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopGeneration()
      loop.stop()
    }
  })

  it('retracts the generation while connecting and publishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const generations: Array<string | undefined> = []
    const reconnectSnapshots: Array<string | undefined> = []
    const stopGeneration = handle.generation.subscribe(() => {
      generations.push(handle.generation.getSnapshot()?.host.home)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => {
        if (state === 'connecting') {
          reconnectSnapshots.push(handle.generation.getSnapshot()?.host.home)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 2, backoffMaxMs: 80, generationReadyTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
      })
      generation.end()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(generations).toEqual(['/h', undefined, '/h']) })
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    } finally {
      stopGeneration()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('publishes connection state directly on the service and isolates subscribers', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const snapshots: Array<ConnectionState | undefined> = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribe = handle.state.subscribe(() => { snapshots.push(handle.state.getSnapshot()) })
    const stopThrowing = handle.state.subscribe(() => { throw new Error('state subscriber failed') })
    expect(handle.state.getSnapshot()).toBeUndefined()

    const loop = handle.start({}, {
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffMaxMs: 80,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.waitFor(() => { expect(handle.state.getSnapshot()).toBe('connected') })
      const connected = handle.state.getSnapshot()
      expect(handle.state.getSnapshot()).toBe(connected)
      generation.end()
      await vi.waitFor(() => {
        expect(snapshots).toEqual([
          'connected',
          'connecting',
          'connected',
        ])
      })
      expect(errorSpy).toHaveBeenCalledWith('[connection] state listener threw:', expect.any(Error))
    } finally {
      unsubscribe()
      stopThrowing()
      loop.stop()
      errorSpy.mockRestore()
    }
    expect(handle.state.getSnapshot()).toBeUndefined()
  })

  it('does not announce disconnection after a generation subscriber stops the loop', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let stoppedOnRetraction = false
    const stopGeneration = handle.generation.subscribe(() => {
      if (handle.generation.getSnapshot() !== undefined || owner.loop === undefined) return
      stoppedOnRetraction = true
      owner.loop.stop()
    })
    const states: ConnectionState[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => { states.push(state) },
    }, { backoffBaseMs: 10, backoffFactor: 2, backoffMaxMs: 80, generationReadyTimeoutMs: 500 })
    owner.loop = loop
    try {
      await vi.waitFor(() => {
        expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
      })
      generation.end()

      await vi.waitFor(() => { expect(stoppedOnRetraction).toBe(true) })
      expect(handle.generation.getSnapshot()).toBeUndefined()
      expect(states).toEqual(['connected'])
    } finally {
      stopGeneration()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('uses an already decoded rpc carrier from the transport hooks instead of the HTTP caller', async () => {
    ;(globalThis as Win).location = { hostname: 'preview.example' }
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => ({ ok: true as const, value: { endpoint, payload } })),
      open: vi.fn((_channel: string, endpoint: string) => (async function *(): AsyncGenerator { yield endpoint })()),
    }
    ;(globalThis as Win).__DSH_TRANSPORT__ = { rpc }
    const handle = await mount()
    expect(handle.rpc).toBe(rpc)
    await expect(handle.rpc.call('/api', 'session/list', { args: [] })).resolves.toEqual({
      ok: true, value: { endpoint: 'session/list', payload: { args: [] } },
    })
  })

  it('exposes a worker-local Gateway stream through connection.rpc.open', async () => {
    ;(globalThis as Win).location = { hostname: 'preview.example' }
    const openStream = vi.fn<NonNullable<ClientTransportHooks['openStream']>>(
      (endpoint, payload, signal, uplink) => (async function *(): AsyncGenerator {
        signal.throwIfAborted()
        yield { endpoint, payload }
        if (uplink !== undefined) yield* uplink
      })(),
    )
    ;(globalThis as Win).__DSH_TRANSPORT__ = {
      fetch: vi.fn<RpcFetch>(),
      openStream,
      ownsHost: true,
    }
    const handle = await mount()
    const abort = new AbortController()
    const open = handle.rpc.open
    if (open === undefined) throw new Error('worker-local stream carrier was not installed')

    const values = []
    for await (const value of open('/api', 'session/follow', { args: { sessionId: 'session-1' } }, abort.signal)) {
      values.push(value)
    }
    expect(values).toEqual([{
      endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } },
    }])
    expect(openStream).toHaveBeenCalledWith(
      'session/follow',
      { args: { sessionId: 'session-1' } },
      abort.signal,
      undefined,
    )

    const uplink = (async function *(): AsyncGenerator<string> { yield 'typed' })()
    const echoed = []
    for await (const value of open('/api', 'job/attach', { args: {} }, abort.signal, uplink)) echoed.push(value)
    expect(echoed).toEqual([{ endpoint: 'job/attach', payload: { args: {} } }, 'typed'])
    expect(openStream).toHaveBeenLastCalledWith('job/attach', { args: {} }, abort.signal, uplink)
    expect(handle.isLoopback).toBe(true)
    expect(() => open('/rpc', 'session/follow', {}, abort.signal))
      .toThrow('worker-local streams require the /api channel')
    expect(() => open('/api/path', 'session/follow', {}, abort.signal))
      .toThrow('invalid RPC target')
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'api/goals/create',
        expect.objectContaining({ signal: abort.signal }),
      )

      ;(globalThis as Win).location = { hostname: 'localhost', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual('api/goals/create')
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal')

      const respond = (result: unknown): void => {
        globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit) => {
          if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
          const request = JSON.parse(init.body) as { rpcId: string }
          return Response.json({ type: 'server-response', rpcId: request.rpcId, result })
        }
      }
      for (const envelope of [
        null,
        { type: 'other', rpcId: 'rpc', result: { ok: true } },
        { type: 'server-response', rpcId: 1, result: { ok: true } },
      ]) {
        globalThis.fetch = vi.fn().mockResolvedValue(Response.json(envelope))
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response envelope')
      }

      respond(null)
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: 'yes' })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: false, error: null })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')

      for (const error of [
        { code: 1, message: 'failed', details: {} },
        { code: 'failed', message: 1, details: {} },
        { code: 'failed', message: 'failed', details: [] },
      ]) {
        respond({ ok: false, error })
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response failure')
      }
      respond({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
      await expect(handle.rpc.call('/api', 'goals/create', {})).resolves.toEqual({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

})
