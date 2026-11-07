/** Host-owned default LLM route for one delegation role's settings namespace. */

import type { Context, Volatile } from '@deepseek-ai/cordis'

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The calling row's settings owner, resolved through the shared registry. */
    subagentWorkerRoute: SubagentWorkerRouteConfig
  }
}

/** User-settings namespace for the default delegation child route. */
export const SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE = 'subagent-worker-route-settings'

/** Stored child route; a tool instance without the opt-in ignores it. */
export interface SubagentWorkerRouteSettings {
  /** Registered LLM provider id for the child. */
  provider: string
  /** Provider-owned exact model id for the child. */
  model: string
  /** Adapter-owned reasoning effort for that child route. */
  reasoningEffort: ReturnType<typeof ReasoningEffortId>
}

/** What one composed route-settings row exposes to the delegation tool reading it. */
export type SubagentRouteSettingsOwner = Pick<SubagentWorkerRouteConfig, 'current'>

/**
 * A route one Session pinned for itself, outranking the row's stored default.
 *
 * A deployment that lets a person choose the formation's models per session
 * needs the delegation rows to read that choice rather than the one global
 * namespace: the pick belongs to the session that made it, and a later edit of
 * another session's pick must not move this one. The row keeps serving
 * `current()` as the default for every session that pinned nothing, so an
 * existing deployment that never writes a pinned route is unchanged.
 */
export interface SubagentRouteSessionResolver {
  /**
   * Read the route this Session pinned for the role this namespace serves.
   * @param session - Session whose own choice is read; for a delegation that is the delegating parent.
   * @returns the pinned route, or undefined to fall through to the row's default.
   */
  forSession(session: Session): SubagentWorkerRouteSettings | undefined
}

/**
 * One namespace's routes as the delegation tool reads them: the row's stored
 * default plus every session pin composed onto it.
 */
export interface SubagentRouteResolution extends SubagentRouteSessionResolver {
  /**
   * Read the row's stored default route.
   * @returns the configured route as a detached value.
   */
  current(): SubagentWorkerRouteSettings
}

/** Deployment base for the preference; every field is required. */
export interface Config {
  /** Settings namespace this instance owns; must equal its Loader entry id. */
  namespace: string
  /** Initial provider inherited when the user document does not override it. */
  provider: Volatile<string>
  /** Initial model inherited when the user document does not override it. */
  model: Volatile<string>
  /** Initial reasoning effort inherited when the user document does not override it. */
  reasoningEffort: Volatile<string>
}

/**
 * Reject a stored route the delegation path could not use.
 * @param value - the resolved route.
 * @throws when any field is empty.
 */
function assertWorkerRoute(value: SubagentWorkerRouteSettings): void {
  for (const field of ['provider', 'model', 'reasoningEffort'] as const) {
    if (value[field].length === 0) {
      throw new Error(`subagent worker route requires a non-empty \`${field}\``)
    }
  }
}

/**
 * One composed row's settings owner, read when a delegation tool resolves its
 * child default route for the role this row serves. The route reaches the LLM
 * adapter only through the delegation preflight, which validates the provider,
 * model, and effort together.
 *
 * A route rewrite is not refused here: a marked child re-reads this setting at
 * every request, so an edit is safe at any point of its life. What owns the
 * refusal is the delegation tool row, which knows which of its children are
 * mid-turn.
 */
export class SubagentWorkerRouteConfig extends Service {
  static inject = ['subagentRouteSettings']

  static Config = z.object({
    namespace: z.string().min(1).required(),
    provider: z.string().min(1).required().volatile(),
    model: z.string().min(1).required().volatile(),
    reasoningEffort: z.string().min(1).required().volatile(),
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentWorkerRoute')
  }

  protected [Service.init](): void {
    // Registration is scoped to this row's fiber, so HMR replacement of one
    // row takes its own registry entry and write guard with it.
    const dispose = this.ctx.subagentRouteSettings.register(this.config.namespace, this)
    this.ctx.effect(() => dispose, 'subagent-worker-route-settings: registry registration')
  }

  /**
   * Read the current default child route for this row's role.
   * @returns the configured route as a detached value.
   */
  current(): SubagentWorkerRouteSettings {
    const route: SubagentWorkerRouteSettings = {
      provider: this.config.provider.get(),
      model: this.config.model.get(),
      reasoningEffort: ReasoningEffortId(this.config.reasoningEffort.get()),
    }
    assertWorkerRoute(route)
    return route
  }
}

export default SubagentWorkerRouteConfig
