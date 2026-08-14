/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-vision-bridge`.
 * @module @deepseek-ai/dsh-vision-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-vision-bridge'

/** Cordis companion plugin name. */
export const name = 'vision-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge has no independent lifecycle stream. Its
 * reconstruction contract is checked by the agent-loop invariant: converted
 * requests are never agent-loop requests, so the loop request stays exactly
 * what the log derives, and the evidence it replaced is reconstructable from
 * the `vision/observed` events this package appends.
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
