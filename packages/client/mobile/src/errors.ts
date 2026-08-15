/**
 * Carrier failure classes: the two error kinds a native client must tell apart
 * (re-pair versus transient transport), plus the pairing failure vocabulary.
 * @module @deepseek-ai/dsh-client-mobile
 */

/** The remote-access gate rejected the session cookie (HTTP 401): the app must re-pair. */
export class UnauthorizedError extends Error {
  constructor() {
    super('the remote-access pairing cookie was rejected (HTTP 401)')
    this.name = 'UnauthorizedError'
  }
}

/** Machine-readable pairing failure category. */
export type PairingFailure = 'invalid-url' | 'rejected' | 'no-cookie' | 'network'

/** Pairing failed for one of the {@link PairingFailure} reasons. */
export class PairingError extends Error {
  /** The failure category the app switches its user copy on. */
  readonly failure: PairingFailure

  /**
   * @param failure - failure category.
   * @param detail - non-sensitive diagnostic detail.
   */
  constructor(failure: PairingFailure, detail: string) {
    super(`pairing failed (${failure}): ${detail}`)
    this.name = 'PairingError'
    this.failure = failure
  }
}
