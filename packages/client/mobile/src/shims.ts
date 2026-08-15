/**
 * Hermes runtime shims: the wire carrier uses AbortSignal.timeout/any and
 * crypto.randomUUID, which Hermes does not ship. Each shim installs only the
 * missing static, so Node and modern Web runtimes keep their native versions.
 * @module @deepseek-ai/dsh-client-mobile
 */

type CryptoLike = {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

interface AbortSignalStatics {
  timeout?: (ms: number) => AbortSignal
  any?: (signals: readonly AbortSignal[]) => AbortSignal
}

/** Abort after a fixed delay, matching WHATWG AbortSignal.timeout. */
function timeout(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => { controller.abort(new Error('signal timed out')) }, ms)
  return controller.signal
}

/** Abort when any input aborts (or immediately when one already aborted), matching WHATWG AbortSignal.any. */
function any(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const aborted = signals.find(signal => signal.aborted)
  if (aborted !== undefined) {
    controller.abort(aborted.reason)
    return controller.signal
  }
  for (const signal of signals) {
    const onAbort = (): void => {
      // The combined signal settles exactly once; drop every input listener so
      // a long-lived caller signal does not accumulate one entry per call.
      for (const other of signals) other.removeEventListener('abort', onAbort)
      controller.abort(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

/**
 * Install AbortSignal.timeout/any when the runtime lacks them (Hermes).
 * Idempotent; existing statics are never replaced.
 */
export function ensureAbortSignalStatics(): void {
  // The cast widens the DOM-typed constructor to the installable surface;
  // each static is installed only when the runtime lacks it.
  const statics = AbortSignal as unknown as AbortSignalStatics
  if (statics.timeout === undefined) statics.timeout = timeout
  if (statics.any === undefined) statics.any = any
}

/**
 * Generate a UUID v4 through the best available source: crypto.randomUUID,
 * then crypto.getRandomValues, then Math.random as the last resort. rpcIds are
 * correlation echo tokens, never secrets, so the fallback chain is acceptable.
 * @returns a fresh UUID v4 string.
 */
export function randomUuid(): string {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (crypto?.getRandomValues !== undefined) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  }
  // Uint8Array indices are always defined at runtime; the fallbacks satisfy noUncheckedIndexedAccess.
  /* v8 ignore next */
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  /* v8 ignore next */
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}
