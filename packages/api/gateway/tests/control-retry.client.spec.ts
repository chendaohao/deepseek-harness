import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  RemoteStreamCarrierError,
  RemoteStream,
  DEFAULT_STREAM_RETRY,
  streamRetryDelay,
  type StreamRetryTimer,
} from '../src/client/index.ts'

const GENERATION = { id: 1, host: { home: '/home/fixture' } }

function hostSource(initiallyAvailable: boolean): {
  connection: Pick<ConnectionHandle, 'generation'>
  publish(available: boolean): void
} {
  let current = initiallyAvailable ? GENERATION : undefined
  const listeners = new Set<() => void>()
  return {
    connection: {
      generation: {
        getSnapshot: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    publish: (available) => {
      current = available ? GENERATION : undefined
      for (const listener of listeners) listener()
    },
  }
}

interface Generation<Item> {
  readonly values?: readonly (Item | Promise<Item>)[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly afterAbortError?: Error
  readonly close?: () => Promise<void>
}

function scripted<Item>(generations: Generation<Item>[], opened?: () => void) {
  return (signal: AbortSignal): AsyncIterable<Item> => ({
    async * [Symbol.asyncIterator](): AsyncIterator<Item> {
      const generation = generations.shift()
      if (generation === undefined) throw new Error('fixture has no stream generation')
      opened?.()
      try {
        for (const value of generation.values ?? []) yield await value
        if (generation.terminal !== undefined) throw generation.terminal
        if (generation.hold === true && !signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        if (generation.afterAbortError !== undefined) throw generation.afterAbortError
      } finally {
        await generation.close?.()
      }
    },
  })
}

function supervisor<Item>(
  connection: Pick<ConnectionHandle, 'generation'>,
  generations: Generation<Item>[],
  carrierFailed?: (error: RemoteStreamCarrierError) => void,
  retryTimer?: StreamRetryTimer,
): RemoteStream<Item> {
  return new RemoteStream(connection, {
    name: 'fixture stream',
    open: scripted(generations),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('accepted generation ended')
      : new Error('generation ended before acceptance'),
    ...(carrierFailed === undefined ? {} : { carrierFailed }),
    ...(retryTimer === undefined ? {} : { retryTimer }),
  })
}

describe('RemoteStream', () => {
  it('annotates replacement generations and resets retry state after acceptance', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first'], terminal: new RemoteStreamCarrierError('first lost') },
      { values: ['second'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first).toMatchObject({ done: false, value: { generation: 1, value: 'first' } })
    if (first.done) throw new Error('fixture generation ended early')
    first.value.accept()
    const second = await iterator.next()
    expect(second).toMatchObject({ done: false, value: { generation: 2, value: 'second' } })
    if (second.done) throw new Error('fixture replacement ended early')
    second.value.accept()

    await stream.dispose()
  })

  it('keeps reopening while the Host remains available, however many times the carrier fails', async () => {
    const source = hostSource(true)
    const failures = [
      new RemoteStreamCarrierError('foreground resume recycled the socket'),
      new RemoteStreamCarrierError('network information change recycled the socket'),
      new RemoteStreamCarrierError('silence deadline expired'),
    ] as const
    const carrierFailed = vi.fn<(error: RemoteStreamCarrierError) => void>()
    // Three carrier failures after the caller already holds a window is the
    // ordinary phone case, not an exceptional one: a foreground return and a
    // radio transition each recycle the shared socket. The fourth generation is
    // the one that lands, so the caller never sees a terminal result.
    const stream = supervisor(source.connection, [
      { values: ['first'], terminal: failures[0] },
      { terminal: failures[1] },
      { terminal: failures[2] },
      { values: ['recovered'], hold: true },
    ], carrierFailed, () => Promise.resolve())
    const iterator = stream[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done) throw new Error('fixture opening ended early')
    opening.value.accept()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { generation: 4, value: 'recovered' },
    })
    expect(carrierFailed.mock.calls.map(([error]) => error)).toEqual(failures)
    await stream.dispose()
  })

  it('gives up a pending first opening after one reopen instead of waiting forever', async () => {
    const source = hostSource(true)
    const first = new RemoteStreamCarrierError('first dial failed')
    const second = new RemoteStreamCarrierError('second dial failed')
    const stream = supervisor(source.connection, [
      { terminal: first },
      { terminal: second },
    ], undefined, () => Promise.resolve())

    // No window exists to keep yet, so the budget stays finite and the caller
    // learns the carrier is unusable instead of waiting on a promise that
    // never settles.
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      isDSHRemoteError: true,
      code: 'gateway/internal',
      message: 'second dial failed',
    })
    await stream.dispose()
  })

  it('waits a growing delay between reopens while the Host remains available', async () => {
    const source = hostSource(true)
    const delays: number[] = []
    const stream = supervisor(source.connection, [
      { values: ['first'], terminal: new RemoteStreamCarrierError('first') },
      { terminal: new RemoteStreamCarrierError('second') },
      { terminal: new RemoteStreamCarrierError('third') },
      { values: ['recovered'], hold: true },
    ], undefined, (delayMs) => {
      delays.push(delayMs)
      return Promise.resolve()
    })
    const iterator = stream[Symbol.asyncIterator]()

    const opening = await iterator.next()
    if (opening.done) throw new Error('fixture opening ended early')
    opening.value.accept()
    await expect(iterator.next()).resolves.toMatchObject({ value: { value: 'recovered' } })
    // Every reopen crosses a macrotask boundary, the first one included: a
    // reopen that resolved on the next microtask would keep the stream inside
    // the microtask queue, and a peer that fails as fast as it reopens would
    // starve every timer on the page.
    expect(delays).toHaveLength(3)
    expect(delays[0]).toBeGreaterThanOrEqual(DEFAULT_STREAM_RETRY.minMs)
    expect(delays[1]).toBeGreaterThanOrEqual(DEFAULT_STREAM_RETRY.minMs)
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0)
    await stream.dispose()
  })

  it('folds a non-Error terminal escape into a marked gateway/internal failure', async () => {
    const stream = new RemoteStream(hostSource(true).connection, {
      name: 'fixture stream',
      open: () => ({
        [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
          next: vi.fn<() => Promise<IteratorResult<string>>>().mockRejectedValue('generation exploded'),
        }),
      }),
      ended: () => new Error('fixture stream ended'),
    })

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      isDSHRemoteError: true,
      code: 'gateway/internal',
      message: 'generation exploded',
    })
  })

  it('passes a marked Remote failure through the terminal boundary verbatim', async () => {
    const failure = new RemoteError('gateway/internal', 'host stream failed', {})
    const stream = supervisor(hostSource(true).connection, [{ terminal: failure }])

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure)
  })

  it('waits for a replacement Host generation after observing unavailability', async () => {
    let available = false
    let listener: (() => void) | undefined
    const subscribed = Promise.withResolvers<undefined>()
    const connection = {
      generation: {
        getSnapshot: () => available ? GENERATION : undefined,
        subscribe: (value: () => void) => {
          listener = value
          subscribed.resolve(undefined)
          return () => { listener = undefined }
        },
      },
    }
    let opened = 0
    const stream = new RemoteStream(connection, {
      name: 'fixture stream',
      open: scripted([
        { terminal: new RemoteStreamCarrierError('offline') },
        { values: ['ready'], hold: true },
      ], () => { opened++ }),
      ended: () => new Error('ended'),
    })
    const pending = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opened).toBe(1) })
    await subscribed.promise

    listener?.()
    expect(opened).toBe(1)
    available = true
    listener?.()
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { generation: 2, value: 'ready' },
    })
    await stream.dispose()
  })

  it('stops a pending retry when the logical stream is disposed', async () => {
    const source = hostSource(false)
    let opened = 0
    const stream = new RemoteStream(source.connection, {
      name: 'fixture stream',
      open: scripted([
        { terminal: new RemoteStreamCarrierError('offline') },
      ], () => { opened++ }),
      ended: () => new Error('ended'),
    })
    const pending = stream[Symbol.asyncIterator]().next()
    await vi.waitFor(() => { expect(opened).toBe(1) })
    source.publish(false)

    await stream.dispose()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('contains a Host publication during subscription setup', async () => {
    let reads = 0
    let disposed = 0
    const connection = {
      generation: {
        getSnapshot: () => reads++ === 0 ? undefined : GENERATION,
        subscribe: (listener: () => void) => {
          listener()
          return () => { disposed++ }
        },
      },
    }
    const stream = supervisor(connection, [
      { terminal: new RemoteStreamCarrierError('offline') },
      { values: ['ready'], hold: true },
    ])

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(disposed).toBe(1)
    await stream.dispose()
  })

  it('restarts with a fresh physical generation', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first'], hold: true },
      { values: ['second'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { generation: 1, value: 'first' } })

    stream.restart()

    await expect(iterator.next()).resolves.toMatchObject({ value: { generation: 2, value: 'second' } })
    await stream.dispose()
  })

  it('drops values and cancellation failures from a replaced generation', async () => {
    const source = hostSource(true)
    const stream = supervisor(source.connection, [
      { values: ['first', 'stale'] },
      {
        values: ['second'],
        hold: true,
        afterAbortError: new Error('replaced generation cancelled'),
      },
      { values: ['third'], hold: true },
    ])
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('fixture generation ended early')

    stream.restart()
    first.value.accept()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { generation: 2, value: 'second' },
    })

    stream.restart()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { generation: 3, value: 'third' },
    })
    await stream.dispose()
  })

  it('honors replacement requested by carrier diagnostics', async () => {
    const source = hostSource(true)
    const holder: { stream?: RemoteStream<string> } = {}
    const carrierFailed = vi.fn(() => { holder.stream?.restart() })
    const stream = supervisor(source.connection, [
      { terminal: new RemoteStreamCarrierError('replace this generation') },
      { values: ['ready'], hold: true },
    ], carrierFailed)
    holder.stream = stream

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(carrierFailed).toHaveBeenCalledOnce()
    await stream.dispose()
  })

  it('contains replacement during Host-readiness subscription setup', async () => {
    const holder: { stream?: RemoteStream<string> } = {}
    let subscriptions = 0
    const connection = {
      generation: {
        getSnapshot: () => undefined,
        subscribe: () => {
          subscriptions++
          holder.stream?.restart()
          return () => {}
        },
      },
    }
    const stream = supervisor(connection, [
      { terminal: new RemoteStreamCarrierError('offline') },
      { values: ['ready'], hold: true },
    ])
    holder.stream = stream

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { generation: 2, value: 'ready' },
    })
    expect(subscriptions).toBe(1)
    await stream.dispose()
  })

  it('waits for generation cleanup during disposal', async () => {
    const source = hostSource(true)
    const release = Promise.withResolvers<undefined>()
    let closed = false
    const stream = supervisor(source.connection, [{
      values: ['ready'],
      hold: true,
      close: async () => {
        await release.promise
        closed = true
      },
    }])
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()

    const disposing = stream.dispose()
    expect(stream.dispose()).toBe(disposing)
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(undefined)

    await expect(disposing).resolves.toBeUndefined()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(closed).toBe(true)
  })

  it('uses the domain normal-end classification and permits one consumer', async () => {
    const source = hostSource(true)
    const stream = supervisor<string>(source.connection, [{}])
    const iterator = stream[Symbol.asyncIterator]()

    expect(() => stream[Symbol.asyncIterator]()).toThrow('already has a consumer')
    await expect(iterator.next()).rejects.toThrow('generation ended before acceptance')
    await stream.dispose()
  })

  it('can be disposed before consumption and ignores later restart', async () => {
    const source = hostSource(true)
    const stream = supervisor<string>(source.connection, [])

    await stream.dispose()
    expect(stream.signal.aborted).toBe(true)
    stream.restart()
    await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    })
  })

  it('drops a value that arrives after disposal begins', async () => {
    const source = hostSource(true)
    const late = Promise.withResolvers<string>()
    const stream = supervisor(source.connection, [{ values: [late.promise] }])
    const pending = stream[Symbol.asyncIterator]().next()
    const disposing = stream.dispose()
    late.resolve('late')

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await disposing
  })

  it('never reopens without a delay, so a failing peer cannot starve the timers', () => {
    // A reopen that resolves on the next microtask keeps the stream inside the
    // microtask queue. Against a peer that fails as fast as it reopens, that is
    // an unbounded synchronous cycle: the page stops running timers and every
    // other stream with it. The floor is what forces each reopen across a
    // macrotask boundary.
    for (const attempt of [0, 1, 2, 3, 8]) {
      expect(streamRetryDelay(attempt)).toBeGreaterThanOrEqual(DEFAULT_STREAM_RETRY.minMs)
    }
    expect(streamRetryDelay(1)).toBe(DEFAULT_STREAM_RETRY.minMs)
    expect(streamRetryDelay(1)).toBeLessThan(streamRetryDelay(4))
  })

  it('waits before serving a generation that a carrier callback restarted', async () => {
    // A control baseline restarts its own stream from `carrierFailed`. Looping
    // straight back to the replacement kept that cycle inside one task, so the
    // page never returned to the macrotask queue and its timers stopped — the
    // frozen phone. The timer is the observable: a restart that reopens without
    // asking it for a delay leaves the reopen order visible and no wait at all.
    const source = hostSource(true)
    const trace: string[] = []
    let opens = 0
    let restarts = 0
    const stream = new RemoteStream<string>(source.connection, {
      name: 'self-restarting stream',
      open: () => ({
        async * [Symbol.asyncIterator](): AsyncIterator<string> {
          opens += 1
          trace.push(`open#${String(opens)}`)
          throw new RemoteStreamCarrierError(`generation ${String(opens)} lost`)
        },
      }),
      ended: () => new Error('unreachable: every generation fails on the carrier'),
      preopenRetries: 8,
      carrierFailed: () => {
        // Exactly what createSessionControlStream does: the callback restarts
        // the stream it was just told died.
        if (restarts < 3) {
          restarts += 1
          stream.restart()
          trace.push('restart')
        }
      },
      retryTimer: (delayMs, _signal) => {
        trace.push(`timer=${String(delayMs)}`)
        return Promise.resolve()
      },
    })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next().catch(() => undefined)
    await stream.dispose()

    expect(restarts).toBe(3)
    // Every callback-driven restart is followed by a timer before the next open.
    // Without the wait the restarts reopen back to back — open#1, restart,
    // open#2, restart, open#3, restart, open#4 — with no timer between them.
    const firstOpen = trace.indexOf('open#1')
    const fourthOpen = trace.indexOf('open#4')
    const waitsBetween = trace.slice(firstOpen, fourthOpen).filter(step => step.startsWith('timer='))
    expect(waitsBetween).toHaveLength(3)
    expect(waitsBetween.every(delay => Number(delay.slice('timer='.length)) >= DEFAULT_STREAM_RETRY.minMs)).toBe(true)
  })

  it('leaves the retry wait when the consumer disposes the stream', async () => {
    // A pending reopen wait is the one place the loop is suspended on something
    // other than the carrier, so disposal has to reach it through the lifetime
    // signal rather than through a rejected open.
    const source = hostSource(true)
    const reached = Promise.withResolvers<undefined>()
    const stream = supervisor(source.connection, [
      { terminal: new RemoteStreamCarrierError('first') },
      { terminal: new RemoteStreamCarrierError('second') },
      { values: ['never'], hold: true },
    ], undefined, (_delayMs, signal) => {
      reached.resolve(undefined)
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await reached.promise
    await stream.dispose()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })


  it('stops reopening when the stream is disposed during a carrier failure', async () => {
    // The abort can land between the failure and the reopen, which both guards
    // on the way out of the catch have to observe: the catch return and the
    // supersede wait.
    const source = hostSource(true)
    let opens = 0
    const stream = new RemoteStream<string>(source.connection, {
      name: 'disposed mid-failure stream',
      open: () => ({
        async * [Symbol.asyncIterator](): AsyncIterator<string> {
          opens += 1
          throw new RemoteStreamCarrierError(`generation ${String(opens)} lost`)
        },
      }),
      ended: () => new Error('unreachable: every generation fails on the carrier'),
      preopenRetries: 8,
      carrierFailed: () => {
        // Dispose from inside the failure callback: the loop must notice on the
        // very next guard instead of starting another generation.
        void stream.dispose()
      },
      retryTimer: () => Promise.resolve(),
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    expect(opens).toBe(1)
  })

  it('does not reset the backoff when a restart replaces the generation', async () => {
    // A restart is the Session layer opening a new generation, not evidence that
    // the carrier recovered. Resetting the attempt count there made the reopen
    // cadence fall back to the floor on every restart, and against a peer that
    // failed just as fast the sequence never climbed at all.
    const source = hostSource(true)
    const delays: number[] = []
    let opens = 0
    const stream = new RemoteStream<string>(source.connection, {
      name: 'restarted stream',
      open: () => ({
        async * [Symbol.asyncIterator](): AsyncIterator<string> {
          opens += 1
          if (opens === 1) yield 'first'
          throw new RemoteStreamCarrierError(`generation ${String(opens)} lost`)
        },
      }),
      ended: accepted => accepted
        ? new RemoteStreamCarrierError('accepted generation ended')
        : new Error('generation ended before acceptance'),
      preopenRetries: 32,
      retryTimer: (delayMs, _signal) => {
        delays.push(delayMs)
        // The stream is inside awaitRetry here, so the restart lands between two
        // reopen attempts exactly as a foreground return would.
        return new Promise<void>((resolve) => {
          if (delays.length === 2) stream.restart()
          setTimeout(resolve, 0)
        })
      },
    })
    const iterator = stream[Symbol.asyncIterator]()
    const opening = await iterator.next()
    if (opening.done) throw new Error('fixture opening ended early')
    opening.value.accept()
    const draining = (async () => { for (;;) { const next = await iterator.next(); if (next.done) return } })()
    for (let i = 0; i < 200 && delays.length < 4; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    const observed = delays.slice(0, 4)
    await stream.dispose()
    await draining.catch(() => undefined)

    expect(observed).toHaveLength(4)
    // The two reopens before the restart climb; the one after it must continue
    // from there rather than dropping back to the floor.
    expect(observed[1] ?? 0).toBeGreaterThan(observed[0] ?? 0)
    expect(observed[3] ?? 0).toBeGreaterThanOrEqual(observed[1] ?? 0)
  }, 15_000)
})
