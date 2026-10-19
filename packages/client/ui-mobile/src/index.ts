/**
 * Host Loader entry for `@deepseek-ai/dsh-client-ui-mobile`. The adaptation
 * layer is browser-only (device detection, the touch stylesheet, and the swipe
 * gestures exported from `./client`); the row stays mounted so the browser
 * roster and the bundle composition keep one entry.
 */

/** Host plugin body — no host-side behavior for the phone adaptation layer. */
export function apply(): void {}
