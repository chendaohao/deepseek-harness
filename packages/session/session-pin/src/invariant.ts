/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-pin`.
 * @module @deepseek-ai/dsh-session-pin/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-pin'

/** Cordis companion plugin name. */
export const name = 'session-pin-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Durable pin-state invariant: every `session/pin` event carries an exact
 * boolean, so the folded state is always one of the two closed values. The
 * service validates before its append; this checks the durable relationship
 * every appended `session/pin` event must keep, whichever writer produced it.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [unknown, SessionEvent]
    if (event.type !== 'session/pin') return
    const { pinned } = event.data as { pinned?: unknown }
    if (typeof pinned !== 'boolean') {
      fail(`session/pin event ${String(event.seq)} must carry a boolean pinned; got ${String(pinned)}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
