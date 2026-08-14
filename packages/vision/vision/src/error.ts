/** Vision failure class. @module @deepseek-ai/dsh-vision/error */

/**
 * Stable failures suitable for host RPC error mapping.
 *
 * Deliberately re-implements the `HarnessError` shape instead of extending it,
 * following the attachment seam precedent: the base lives in
 * `@deepseek-ai/dsh-llm`, which is a provider-side dependency, while this
 * definition package stays dependency-light. Consumers route on `code`, never
 * on the prototype chain.
 */
export class VisionError extends Error {
  /** Stable machine-routing failure code. */
  readonly code: string

  /**
   * @param message - human-readable failure description without raw bytes or host paths.
   * @param code - stable machine-routing code.
   * @param options - optional chained cause.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VisionError'
    this.code = code
  }
}
