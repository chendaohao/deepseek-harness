/** Host-side registry that shares one route-settings owner per settings namespace. */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { SettingsWriteGuardRegistration } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { subagentRouteWriteRefusal } from './worker-route-guard.ts'
import { subagentWorkerRouteMark } from './worker-route-state.ts'
import type {
  SubagentRouteResolution,
  SubagentRouteSessionResolver,
  SubagentRouteSettingsOwner,
  SubagentWorkerRouteSettings,
} from './worker-route-settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-namespace owners registered by the composed route-settings rows. */
    subagentRouteSettings: SubagentRouteSettingsRegistry
  }
}

/** One namespace's registration: its route owner, session pins, and the write guard the registry holds. */
interface RouteRegistration {
  owner: SubagentRouteSettingsOwner
  /** Session-scoped sources that outrank the owner's stored default, in registration order. */
  resolvers: SubagentRouteSessionResolver[]
  guard?: SettingsWriteGuardRegistration
}

/**
 * Single registry the composed route-settings rows publish into, so three
 * namespace rows never fight over one service name. Each registration is
 * scoped to the registering row and releases its write guard on unregister.
 *
 * A deployment whose routes vary per Session registers one resolver per
 * namespace beside the row. The row keeps its settings entry, its stored
 * default, and its write guard; a resolver only answers the narrower question
 * "did THIS Session pin a route", and the delegation tool reads the answer
 * through {@link SubagentRouteSettingsRegistry.resolutionOf}.
 */
export class SubagentRouteSettingsRegistry extends Service {
  // The write guard reads the durable worker-route marker on every evaluation,
  // so the projection registry is a dependency of this row, not of the guard's
  // caller. Declaring it keeps the read strict; reading `ctx.sessionProjections`
  // without it throws inside the guard, which the settings service surfaces as
  // a failed `describe()` for every namespace at once.
  static inject = ['sessionProjections']

  private registrations = new Map<string, RouteRegistration>()
  /** Namespaces whose settle-publish listener is installed on the root context. */
  private listened = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'subagentRouteSettings')
  }

  /**
   * Publish one namespace's route owner and hold its write guard.
   * @param namespace - settings namespace the owner reads; the guard locks
   *   exactly this namespace while a child following it runs.
   * @param owner - the route owner registered for the namespace.
   * @throws when the namespace already has a live registration.
   * @returns the disposer the registering row adopts into its own effect.
   */
  register(namespace: string, owner: SubagentRouteSettingsOwner): () => void {
    if (this.registrations.has(namespace)) {
      throw new Error(`subagent route settings: namespace "${namespace}" is already registered by another route-settings row`)
    }
    this.registrations.set(namespace, { owner, resolvers: [] })
    const settingsService = this.ctx.get('settings')
    const registration = this.registrations.get(namespace)
    const guard = settingsService?.guard(namespace, () =>
      subagentRouteWriteRefusal(this.ctx.sessionProjections, this.ctx.get('agents')?.list() ?? [], namespace))
    if (guard !== undefined && registration !== undefined) {
      registration.guard = guard
      // The guard predicate is pull-based, so a flip is published from the
      // transition that causes it: a marked child entering or leaving
      // 'running'. The listener lives on the root context because agent
      // contexts chain there, not through the registering row's fiber scope;
      // one listener per namespace survives repeated registrations. The
      // effect ties it to this registry service's own fiber, so disposing the
      // registry removes every listener it installed and a re-mount starts
      // from a fresh set instead of accumulating them.
      const root = this.ctx.root
      if (!this.listened.has(namespace)) {
        this.listened.add(namespace)
        this.ctx.effect(() => root.on('agent/status', ({ agent }) => {
          const registration = this.registrations.get(namespace)
          if (registration === undefined) return
          if (subagentWorkerRouteMark(this.ctx.sessionProjections, agent.session) === namespace) registration.guard?.refresh()
        }), 'subagent-route-settings-registry: settle-refresh listener')
      }
    }
    return () => {
      const registration = this.registrations.get(namespace)
      if (registration === undefined) return
      registration.guard?.dispose()
      this.registrations.delete(namespace)
    }
  }

  /**
   * Publish one Session-scoped source for a namespace that already has a row.
   *
   * The resolver outranks the row's stored default for the sessions that pin a
   * route, and the row keeps serving every session that pins none. Registration
   * order decides between several resolvers for one namespace, so a deployment
   * registers at most one per role.
   * @param namespace - settings namespace whose route this source narrows.
   * @param resolver - the per-Session read.
   * @throws when no composed row serves the namespace; the row is what a
   *   deployment without the pin capability still resolves.
   * @returns the disposer the registering plugin adopts into its own effect.
   */
  registerResolver(namespace: string, resolver: SubagentRouteSessionResolver): () => void {
    const registration = this.registrations.get(namespace)
    if (registration === undefined) {
      throw new Error(
        `subagent route settings: namespace "${namespace}" has no serving row, so a session resolver has nothing to narrow`,
      )
    }
    registration.resolvers.push(resolver)
    return () => {
      const current = this.registrations.get(namespace)
      if (current === undefined) return
      const at = current.resolvers.indexOf(resolver)
      if (at >= 0) current.resolvers.splice(at, 1)
    }
  }

  /**
   * Read the owner registered for one namespace.
   * @param namespace - settings namespace a delegation row declared.
   * @returns the owner, or undefined when no composed row serves it.
   */
  resolve(namespace: string): SubagentRouteSettingsOwner | undefined {
    return this.registrations.get(namespace)?.owner
  }

  /**
   * Read one namespace's routes as a delegation should use them.
   * @param namespace - settings namespace a delegation row declared.
   * @returns the row default plus the session pins, or undefined when no row serves it.
   */
  resolutionOf(namespace: string): SubagentRouteResolution | undefined {
    const registration = this.registrations.get(namespace)
    if (registration === undefined) return undefined
    const { owner, resolvers } = registration
    return {
      current: () => owner.current(),
      forSession: (session: Session): SubagentWorkerRouteSettings | undefined => {
        for (const resolver of resolvers) {
          const route = resolver.forSession(session)
          if (route !== undefined) return route
        }
        return undefined
      },
    }
  }
}

/** Plugin identity: the Service class doubles as the plugin; mounting it publishes the registry. */
export const name = 'subagent-route-settings-registry'

export default SubagentRouteSettingsRegistry
