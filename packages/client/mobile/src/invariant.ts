/**
 * Package-owned invariant companion for \`@deepseek-ai/dsh-client-mobile\`.
 * @module @deepseek-ai/dsh-client-mobile/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-mobile'

/** Cordis companion plugin name. */
export const name = 'client-mobile-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a library for the native app and is
 * never composed into a cordis runtime; its wire behavior is owned by the
 * unit suite plus the keyless tunnel e2e in apps/web.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
