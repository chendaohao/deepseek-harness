/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-remote-tunnel`.
 * @module @deepseek-ai/dsh-remote-tunnel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-tunnel'

/** Cordis companion plugin name. */
export const name = 'remote-tunnel-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owned relationship (one spawned cloudflared child
 * per live session, closed and awaited on dispose) exists only inside the
 * Service and has no event stream a companion can observe without starting a
 * real tunnel; unit tests exercise spawn, teardown, and the `remote-tunnel/state`
 * event contract directly.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
