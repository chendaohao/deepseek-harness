/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-remote`.
 * @module @deepseek-ai/dsh-client-ui-remote/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-remote'

/** Cordis companion plugin name. */
export const name = 'client-ui-remote-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the desktop panel is browser viewing state over the
 * remote-access control-plane HTTP routes and the forwarded
 * `remote/devices/change` / `remote-tunnel/state` events, and the node half's
 * `/m` routes are effect-disposed registrations gated by `config.enabled`
 * (route conflicts fail loud in the webserver core). The panel's fetch/event
 * wiring is covered by component tests and the node half's route
 * registration by a mounted-fiber spec rather than a Cordis runtime
 * relationship.
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
