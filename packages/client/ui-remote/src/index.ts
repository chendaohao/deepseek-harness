/**
 * Host loader entry for `@deepseek-ai/dsh-client-ui-remote`. The host half has
 * no behavior of its own: the remote surface is browser-only (the desktop
 * pairing/device panel exported from `./client`), riding the remote-access
 * control plane over the platform `/api` transport. The row stays mounted so
 * the browser roster and the workspace-ext bundle composition keep one entry.
 */

/** Host plugin body — no host-side behavior for the remote-control surface. */
export function apply(): void {}
