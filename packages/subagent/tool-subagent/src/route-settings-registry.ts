/** Host-side registry that shares one route-settings owner per settings namespace. */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { SettingsWriteGuardRegistration } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import { subagentRouteWriteRefusal } from './worker-route-guard.ts'
import { subagentWorkerRouteMark } from './worker-route-state.ts'
import type { SubagentRouteSettingsOwner } from './worker-route-settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-namespace owners registered by the composed route-settings rows. */
    subagentRouteSettings: SubagentRouteSettingsRegistry
  }
}

/** One namespace's registration: its route owner plus the write guard the registry holds for it. */
interface RouteRegistration {
  owner: SubagentRouteSettingsOwner
  guard?: SettingsWriteGuardRegistration
}

/**
 * Single registry the composed route-settings rows publish into, so three
 * namespace rows never fight over one service name. Each registration is
 * scoped to the registering row and releases its write guard on unregister.
 */
export class SubagentRouteSettingsRegistry extends Service {
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
    this.registrations.set(namespace, { owner })
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
          if (subagentWorkerRouteMark(root.sessionProjections, agent.session) === namespace) registration.guard?.refresh()
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
   * Read the owner registered for one namespace.
   * @param namespace - settings namespace a delegation row declared.
   * @returns the owner, or undefined when no composed row serves it.
   */
  resolve(namespace: string): SubagentRouteSettingsOwner | undefined {
    return this.registrations.get(namespace)?.owner
  }
}

/** Plugin identity: the Service class doubles as the plugin; mounting it publishes the registry. */
export const name = 'subagent-route-settings-registry'

export default SubagentRouteSettingsRegistry
