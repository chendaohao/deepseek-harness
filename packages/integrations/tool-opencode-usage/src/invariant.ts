/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-opencode-usage`.
 * @module @deepseek-ai/dsh-tool-opencode-usage/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-opencode-usage'

/** Cordis companion plugin name. */
export const name = 'tool-opencode-usage-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tool is a read-only external query — it appends no
 * session events and owns no durable stream, so there is nothing to validate.
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
