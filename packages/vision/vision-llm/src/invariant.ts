/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-vision-llm`.
 * @module @deepseek-ai/dsh-vision-llm/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-vision-llm'

/** Cordis companion plugin name. */
export const name = 'vision-llm-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider owns no lifecycle stream; observation
 * requests and their reconstruction records are owned by the consuming
 * bridge and tool packages.
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
