/**
 * Device gate for the phone adaptation layer. The layer exists because the
 * shipped Web GUI is a desktop layout: nothing in `packages/client` carries a
 * portrait, coarse-pointer, or safe-area rule, so a phone gets desktop sizing
 * and a composer that zooms on focus.
 *
 * Deliberately a second copy of the transport's phone predicate rather than an
 * import of it. `@deepseek-ai/dsh-api-gateway/client` owns `isPhoneWeb` for the
 * stream-recycle decision, but a UI plugin reaching into a transport package
 * would be a new cross-layer edge; the presentation layer reads the device, it
 * does not read the wire. Keep the two in step: both must answer "phone" for
 * the same device, or the layer would style a page the transport does not
 * treat as phone.
 * @module @deepseek-ai/dsh-client-ui-mobile/device
 */

/** Environment seams, injectable so specs need no real media-query engine. */
export interface DeviceEnvironment {
  /** Media-query evaluator; absent on runtimes without `matchMedia`. */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined
  /** User agent, the fallback for runtimes without `matchMedia`. */
  readonly userAgent?: string | undefined
}

/** Session flag a user sets to opt out of the layer for this tab. */
export const FORCE_DESKTOP_KEY = 'dsh-remote-force-desktop'

/** Phone-class user agents, the fallback when no media-query engine exists. */
const PHONE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile/i

/**
 * Whether this page load runs on a phone-class device: a touch-primary pointer
 * with no hover capability, with a mobile user-agent fallback for runtimes
 * without `matchMedia`.
 *
 * The `(hover: hover)` check leads so a laptop touchscreen — coarse pointer,
 * but hovering — is excluded; styling such a page for touch would shrink the
 * desktop layout on a device that has a mouse and a keyboard.
 * @param environment - media-query and user-agent sources; defaults to the browser globals.
 * @returns whether the phone adaptation layer should apply.
 */
export function isPhoneDevice(environment: DeviceEnvironment = {}): boolean {
  const globals = globalThis as {
    matchMedia?: (query: string) => { matches: boolean }
    navigator?: { userAgent?: string }
  }
  const matchMedia = environment.matchMedia ?? globals.matchMedia
  if (matchMedia !== undefined) {
    if (matchMedia('(hover: hover)').matches) return false
    if (matchMedia('(pointer: coarse)').matches) return true
  }
  const userAgent = environment.userAgent ?? globals.navigator?.userAgent ?? ''
  return PHONE_USER_AGENT.test(userAgent)
}