/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-remote-access`.
 * @module @deepseek-ai/dsh-remote-access/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-remote-access'

/** Cordis companion plugin name. */
export const name = 'remote-access-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the owned relationships (secret-derived tickets and
 * cookies, the gate matrix, proxy header normalization, and tunnel/restart
 * lifecycle) are exercised by unit tests and the keyless browser e2e; the
 * service emits no event stream a companion could observe.
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

