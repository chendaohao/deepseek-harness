/**
 * Retry cadence for one logical Remote stream whose physical carrier keeps
 * failing while the Host generation itself stays current.
 *
 * A carrier failure reaches a stream two ways, and they mean different things.
 * When the Connection generation is gone, the page has lost its Host and the
 * stream waits for the next generation — Connection owns that wait. When the
 * generation is still current, only the mux socket died: a foreground resume
 * recycled it, a radio transition broke its TCP leg, or the silence deadline
 * fired. The Host is still reachable, so the stream reopens under this cadence
 * and the caller never sees that as a terminal result.
 */

/** Retry timing for a stream whose generation is still available. */
export interface StreamRetryConfig {
  /** Delay cap of the first tier in ms; the first reopen itself waits nothing. */
  readonly baseMs: number
  /** Delay floor in ms. */
  readonly minMs: number
  /** Growth factor per attempt, at least 1. */
  readonly factor: number
  /** Maximum retry delay in ms; retries continue at this cap. */
  readonly maxMs: number
  /** Whether a random fraction of the delay is subtracted. */
  readonly jitter: boolean
}

/**
 * Default cadence.
 *
 * The first reopen is immediate because two socket recycles in a row is the
 * ordinary phone case rather than an exceptional one: a foreground return and
 * one Network Information change both recycle the shared socket. Afterwards the
 * delay grows from a 2 s cap to 10 s and stays there, because a generation that
 * is still current is evidence the Host answers, so waiting longer only delays
 * recovery the user is watching for.
 */
export const DEFAULT_STREAM_RETRY: StreamRetryConfig = Object.freeze({
  baseMs: 2_000,
  minMs: 200,
  factor: 2,
  maxMs: 10_000,
  jitter: true,
})

/** Schedule one delay; the caller cancels it through `signal`. */
export type StreamRetryTimer = (delayMs: number, signal: AbortSignal) => Promise<void>

/**
 * Carrier failures tolerated before a stream's first opening settles as a
 * failure.
 *
 * A pending first open has no window for its caller to keep: retrying it
 * forever would turn one call into an unbounded wait whose only exit is the
 * caller's own cancellation. One reopen fits a recovering radio — that reopen
 * is immediate — while still settling a carrier that is simply unusable as the
 * failure the caller must report. Once an opening is accepted this budget no
 * longer applies.
 */
export const DEFAULT_PREOPEN_RETRIES = 1

/**
 * Delay before one reopen of a stream whose generation is still available.
 *
 * The first attempt reopens immediately. Later attempts grow from `baseMs`
 * toward `maxMs`, each subtracting a random half so two streams that failed
 * together do not reopen together.
 * @param attempt - 1 for the first reopen after a carrier failure.
 * @param config - retry timing.
 * @param random - jitter source in [0, 1).
 * @returns milliseconds to wait; 0 reopens on the next turn.
 */
export function streamRetryDelay(
  attempt: number,
  config: StreamRetryConfig = DEFAULT_STREAM_RETRY,
  random: () => number = Math.random,
): number {
  if (attempt <= 1) return 0
  const tier = Math.min(config.maxMs, config.baseMs * config.factor ** (attempt - 2))
  const delay = config.jitter ? tier / 2 + random() * (tier / 2) : tier
  return Math.max(config.minMs, Math.round(delay))
}

/**
 * Wait one retry delay, ending early when the caller cancels.
 * The delay rejects with the signal's reason so a stream can tell cancellation
 * from the delay simply elapsing.
 * @param delayMs - milliseconds to wait.
 * @param signal - cancellation lifetime of the attempt.
 * @returns after the delay, or after cancellation.
 */
export const defaultStreamRetryTimer: StreamRetryTimer = (delayMs, signal) => new Promise<void>(
  (resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    if (delayMs <= 0) {
      resolve()
      return
    }
    const aborted = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delayMs)
    // A pending retry must not keep a Node test or CLI process alive.
    const handle = timer as { unref?: () => void }
    handle.unref?.()
    signal.addEventListener('abort', aborted, { once: true })
  },
)

/**
 * Cancellation reason as an Error, so a rejected delay always carries one.
 * @param signal - the cancelled lifetime.
 * @returns the signal's reason, wrapped when it is not already an Error.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Remote stream retry aborted', { cause: signal.reason })
}
