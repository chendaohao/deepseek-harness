/** Reconnecting lifecycle for one single-consumer Remote stream. */

import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStreamCarrierError } from './stream-client.ts'
import {
  DEFAULT_PREOPEN_RETRIES,
  DEFAULT_STREAM_RETRY,
  defaultStreamRetryTimer,
  streamRetryDelay,
  type StreamRetryConfig,
  type StreamRetryTimer,
} from './stream-retry.ts'

/** One item annotated with the physical Remote-stream generation that delivered it. */
export interface RemoteStreamItem<Item> {
  /** Monotone physical generation number within this logical stream. */
  readonly generation: number
  /** Decoded item yielded by the generated Remote method. */
  readonly value: Item
  /** Cancellation lifetime of the generation that delivered this item. */
  readonly signal: AbortSignal
  /** Mark this generation's opening baseline or cursor as accepted. */
  accept(): void
}

/** Domain-owned operations used by {@link RemoteStream}. */
export interface RemoteStreamOptions<Item> {
  /** Diagnostic owner name used for cancellation failures. */
  readonly name: string
  /** Open one physical generation of the logical stream. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** Classify a normal generation end after or before its opening item was accepted. */
  readonly ended: (accepted: boolean) => Error
  /** Observe a retryable carrier loss before the supervisor waits or reopens. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /**
   * Reopen cadence while the Host generation is still available. Omitted fields
   * keep {@link DEFAULT_STREAM_RETRY}.
   */
  readonly retry?: Partial<StreamRetryConfig>
  /**
   * Delay implementation, injectable so tests need no real timers. Defaults to
   * {@link defaultStreamRetryTimer}.
   */
  readonly retryTimer?: StreamRetryTimer
  /**
   * Carrier failures tolerated before the stream's first opening settles as a
   * failure, so a consumer whose call is still pending learns the carrier is
   * unusable instead of waiting forever. Once an opening has been accepted the
   * budget no longer applies: the caller holds a window, and only a lost Host
   * generation ends it. Default: {@link DEFAULT_PREOPEN_RETRIES}.
   */
  readonly preopenRetries?: number
}

/**
 * Reopens one logical Remote stream across carrier generations.
 *
 * Connection owns physical retry timing; Gateway performs each requested
 * replacement. The domain consumer owns its opening item and every later
 * item, and calls {@link RemoteStreamItem.accept} only after validating the
 * opening baseline or cursor.
 *
 * A carrier failure while the Connection generation is current is retried
 * here, indefinitely: only the mux socket died, so a foreground resume, a radio
 * transition, or the silence deadline must never end a stream a caller is
 * reading. Once the generation is gone the stream instead waits for the next
 * generation, which Connection publishes after its own backoff.
 */
export class RemoteStream<Item> implements AsyncIterable<RemoteStreamItem<Item>> {
  private readonly lifetime = new AbortController()
  private readonly retry: StreamRetryConfig
  private readonly retryTimer: StreamRetryTimer
  private generationAbort: AbortController | undefined
  private iterator: AsyncGenerator<RemoteStreamItem<Item>> | undefined
  private closing: Promise<void> | undefined
  private revision = 0
  private taken = false
  /** Whether any generation has accepted an opening item, so a window exists. */
  private opened = false

  /**
   * @param connection - observable Host generation source used to pace retries.
   * @param options - domain stream opener, end classification, and diagnostics.
   */
  constructor(
    private readonly connection: Pick<ConnectionHandle, 'generation'>,
    private readonly options: RemoteStreamOptions<Item>,
  ) {
    this.retry = { ...DEFAULT_STREAM_RETRY, ...options.retry }
    this.retryTimer = options.retryTimer ?? defaultStreamRetryTimer
  }

  /** Cancellation lifetime shared by the stream and sibling page requests. */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  /** Interrupt the current generation and immediately request a replacement. */
  restart(): void {
    if (this.lifetime.signal.aborted) return
    this.revision++
    this.generationAbort?.abort(new Error(`${this.options.name} generation restarted`))
  }

  /**
   * Permanently stop this stream and wait for its iterator to close.
   * @returns when the active generation and consumer iterator are quiescent.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    if (!this.lifetime.signal.aborted) {
      const reason = new Error(`${this.options.name} disposed`)
      this.lifetime.abort(reason)
      this.generationAbort?.abort(reason)
    }
    const iterator = this.iterator
    if (iterator === undefined) return Promise.resolve()
    const closing = closeRemoteStreamIterator(iterator)
    this.closing = closing
    return closing
  }

  /** @inheritdoc */
  [Symbol.asyncIterator](): AsyncIterator<RemoteStreamItem<Item>> {
    if (this.taken) throw new Error(`${this.options.name} already has a consumer`)
    this.taken = true
    const iterator = this.read()
    this.iterator = iterator
    return iterator
  }

  private async * read(): AsyncGenerator<RemoteStreamItem<Item>> {
    let attempt = 0
    let generation = 0
    let observedRevision = this.revision
    try {
      while (!isAborted(this.lifetime.signal)) {
        // A revision change means another generation started, not that the
        // carrier recovered, so it must not reset the backoff: a stream whose
        // peer fails as fast as it reopens would otherwise never leave attempt
        // 1, and the two together spin in the microtask queue with no delay at
        // all. Only an accepted opening proves recovery, and that reset lives
        // in accept() below.
        if (observedRevision !== this.revision) {
          observedRevision = this.revision
        }
        const revision = this.revision
        const generationAbort = new AbortController()
        this.generationAbort = generationAbort
        const signal = AbortSignal.any([this.lifetime.signal, generationAbort.signal])
        const generationId = ++generation
        let accepted = false
        try {
          for await (const value of this.options.open(signal)) {
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) break
            yield {
              generation: generationId,
              value,
              signal,
              accept: () => {
                if (this.generationAbort !== generationAbort || revision !== this.revision) return
                accepted = true
                this.opened = true
                attempt = 0
              },
            }
          }
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
          throw this.options.ended(accepted)
        } catch (error) {
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) {
            await this.awaitSupersede(attempt)
            continue
          }
          if (!(error instanceof RemoteStreamCarrierError)) throw terminalStreamFailure(error)
          this.options.carrierFailed?.(error)
          // The carrier callback may restart this very stream (a control
          // baseline does), so the revision check below has to yield before it
          // loops. Without a wait here a superseded generation re-enters the
          // loop in the same task, and a callback that restarts on every failure
          // keeps it there: the page never returns to the macrotask queue.
          if (revision !== this.revision) {
            attempt++
            await this.awaitSupersede(attempt)
            continue
          }
          // Before the first opening there is no window for a caller to keep,
          // so the retry budget stays finite and the opening settles with a
          // failure the consumer can report. Afterwards the caller is reading
          // the window, and only a lost Host generation may end it.
          if (!this.opened && attempt >= (this.options.preopenRetries ?? DEFAULT_PREOPEN_RETRIES)) {
            throw terminalStreamFailure(error)
          }
          attempt++
          try {
            await this.awaitRetry(attempt, signal)
          } catch {
            // The wait only fails by cancellation: the consumer disposed the
            // stream or the generation was replaced under this iteration.
            // Neither is a stream failure, so both leave through the loop's
            // own guards rather than the terminal boundary.
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) continue
            return
          }
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
        } finally {
          this.generationAbort = undefined
          if (!generationAbort.signal.aborted) {
            generationAbort.abort(new Error(`${this.options.name} generation ended`))
          }
        }
      }
    } finally {
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort(new Error(`${this.options.name} consumer closed`))
      }
      this.generationAbort?.abort(this.lifetime.signal.reason)
      this.generationAbort = undefined
    }
  }

  /**
   * Wait out one cadence step before re-entering the loop after a superseded
   * generation.
   *
   * A superseded generation is a restart, not an escape: the loop must go round
   * again to serve the replacement. Re-entering it synchronously is what turns
   * a restart-on-failure callback into an unbounded loop that never yields to
   * the macrotask queue, so this wait is the yield. It shares the reopen cadence
   * so a caller cannot tell a supersede from a carrier reopen.
   * @param attempt - reopen attempts completed by this consumer.
   */
  private async awaitSupersede(attempt: number): Promise<void> {
    // The supersede path must not read the generation signal: that signal is the
    // one the restart aborted, and its abort is what brought the loop here. Only
    // the consumer's own lifetime cancels this wait.
    if (isAborted(this.lifetime.signal)) return
    await this.retryTimer(streamRetryDelay(attempt, this.retry), this.lifetime.signal)
  }

  /**
   * Wait out the cadence for one reopen after a carrier failure.
   *
   * The generation decides which wait applies. While it is current the Host is
   * reachable and only the socket died, so the stream reopens under its own
   * bounded backoff, for as long as the consumer keeps reading — a page must
   * recover from a recycled socket without the user reloading. When the
   * generation is gone, Connection rebuilds the carrier under its own backoff
   * and this waits for the next generation it publishes, because reopening
   * earlier would only dial a Host the page cannot reach.
   *
   * Cancellation and a consumer-driven restart both escape as a rejection the
   * caller suppresses; neither is a terminal stream failure.
   * @param attempt - 1 for the first reopen after a carrier failure.
   * @param signal - cancellation lifetime of the attempt.
   */
  private async awaitRetry(attempt: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.connection.generation.getSnapshot() === undefined) {
      await waitForHostGeneration(this.connection, signal)
      return
    }
    await this.retryTimer(streamRetryDelay(attempt, this.retry), signal)
  }
}

/**
 * Wait until Connection publishes a generation.
 *
 * The caller has already established that no generation is current. Resolves
 * at once if one arrives during subscription setup — a publication between the
 * two checks must not be missed — and rejects on cancellation.
 * @param connection - the generation source to observe.
 * @param signal - cancellation lifetime of the attempt.
 */
async function waitForHostGeneration(
  connection: Pick<ConnectionHandle, 'generation'>,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const subscription: {
      dispose?: () => void
      finished: boolean
    } = { finished: false }
    const finish = (failure?: Error): void => {
      if (subscription.finished) return
      subscription.finished = true
      subscription.dispose?.()
      signal.removeEventListener('abort', aborted)
      if (failure === undefined) resolve()
      else reject(failure)
    }
    const inspect = (): void => {
      if (connection.generation.getSnapshot() !== undefined) finish()
    }
    const aborted = (): void => {
      finish(new Error('Remote stream retry aborted', { cause: signal.reason }))
    }
    const dispose = connection.generation.subscribe(inspect)
    subscription.dispose = dispose
    if (subscription.finished) dispose()
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else inspect()
  })
}

/**
 * Mark a terminal escape before it crosses the stream boundary: consumers
 * discriminate failures by code, so an unmarked throw reads as a local bug.
 * Marked failures pass through verbatim. The carrier class never escapes as a
 * terminal outcome — it stays the retry-internal signal fed to `carrierFailed`
 * and the `ended(true)` retry trigger.
 */
function terminalStreamFailure(error: unknown): Error {
  return remoteErrorOf(error) ?? new RemoteError(
    'gateway/internal',
    error instanceof Error ? error.message : String(error),
    {},
    { cause: error },
  )
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

async function closeRemoteStreamIterator<Item>(
  iterator: AsyncIterator<RemoteStreamItem<Item>>,
): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // The disposed logical stream has no remaining consumer for cancellation failures.
  }
}
