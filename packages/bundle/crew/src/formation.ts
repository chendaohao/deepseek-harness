/**
 * The crew session's formation ownership: which routes its three delegation
 * roles run on, chosen once per session from the Models page's combinations.
 *
 * A crew session picks a combination when it starts, and the pick stays its
 * own. This service is the one place that decides both halves: it records the
 * set on the session, and it answers the per-role read that each delegation
 * row performs through `subagentRouteSettings`. A session that recorded no set
 * answers nothing, and the row keeps its own stored default — which is what
 * keeps a deployment that never opens the picker unchanged.
 *
 * The namespaces stay the settings each row owns. This service registers one
 * resolver per namespace, so the three rows keep their existing ids, settings
 * entries, and write guards; only the *source* of a route becomes
 * session-scoped once a session recorded one.
 * @module @deepseek-ai/dsh-crew/formation
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { SubagentRouteSessionResolver } from '@deepseek-ai/dsh-tool-subagent/worker-route-settings'
import type { SubagentWorkerRouteSettings } from '@deepseek-ai/dsh-tool-subagent/worker-route-settings'
// Type-only: pulls the `subagentRouteSettings` Context merge into this program.
import type {} from '@deepseek-ai/dsh-tool-subagent/route-settings-registry'
import {
  CREW_ROLES,
  crewRoutesOf,
  crewRoutesProjectionDefinition,
  recordCrewRoutes,
  replaceCrewRoleRoute,
  type CrewRoutesState,
} from './routes.ts'
import { CrewRunBudget, type CrewRunBudgetConfig } from './run-budget.ts'
// Client-safe vocabulary: these names cross the Remote boundary, so they live
// on the package's `./types` subpath and this module only re-states their use.
import type {
  CrewRole,
  CrewRoleRoute,
  CrewRoleRouteView,
  CrewRouteSelection,
  CrewSessionView,
} from './types.ts'


/** Cordis plugin name used by loader diagnostics. */
export const name = 'crew-formation'
/** Services required to own a session's formation. */
export const inject = ['sessionProjections', 'subagentRouteSettings', 'tokenMeter']

/** Deployment namespaces, in the order the Models page renders them. */
export interface Config {
  /** Settings namespace serving the worker role's default route. */
  worker: string
  /** Settings namespace serving the planner role's default route. */
  planner: string
  /** Settings namespace serving the reviewer role's default route. */
  reviewer: string
  /** Per-turn limits applied to every Crew role child. */
  readonly budget?: CrewRunBudgetConfig
}

/**
 * One session's formation, and the per-role read the delegation rows perform.
 *
 * A resolver is registered for each role namespace rather than replacing the
 * route-settings rows: the row keeps owning the settings entry, its write
 * guard, and its stored default, and this service only answers the narrower
 * question "did THIS session pin a route for that role".
 */
export class CrewFormation extends TypertRemoteService {
  static inject = ['sessionProjections', 'subagentRouteSettings', 'llm', 'tokenMeter']

  private handle!: ProjectionHandle<CrewRoutesState>

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'crewFormation')
  }

  protected async [Service.init](): Promise<void> {
    this.handle = await this.ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const runBudget = new CrewRunBudget(this.ctx, this.config.budget)
    runBudget.start()
    for (const role of CREW_ROLES) {
      const namespace = this.config[role]
      const dispose = this.ctx.subagentRouteSettings.registerResolver(namespace, this.resolverFor(role))
      this.ctx.effect(() => dispose, `crew-formation: ${namespace} session resolver`)
    }
  }

  /**
   * The resolver one role namespace delegates to.
   * @param role - the role that namespace serves.
   * @returns the read the routing layer performs per delegation.
   */
  private resolverFor(role: CrewRole): SubagentRouteSessionResolver {
    return {
      forSession: (session: Session): SubagentWorkerRouteSettings | undefined => {
        const route = this.recorded(session)?.routes?.[role]
        if (route === undefined) return undefined
        return {
          provider: route.provider,
          model: route.model,
          reasoningEffort: ReasoningEffortId(route.reasoningEffort),
        }
      },
    }
  }

  /**
   * Read what one session recorded, for a surface that renders it.
   * @param agent - live Agent whose formation is read.
   * @returns the recorded formation; `routes` is null when none was recorded.
   */
  @Remote('view')
  view(agent: Agent): CrewSessionView {
    return this.viewOf(agent.session)
  }

  /**
   * Read one session's formation from the Host itself.
   * @param session - session whose formation is read.
   * @returns the recorded formation; `routes` is null when none was recorded.
   */
  viewOf(session: Session): CrewSessionView {
    const state = this.recorded(session)
    return {
      sessionId: session.id,
      presetId: state?.presetId ?? null,
      presetName: state?.presetName ?? null,
      routes: state?.routes === null || state?.routes === undefined
        ? null
        : CREW_ROLES.map(role => ({ role, ...state.routes?.[role] } as CrewRoleRouteView)),
      replaced: state?.replaced ?? [],
    }
  }

  /**
   * Record a session's complete route set from a combination.
   *
   * Every role is validated against the resolved catalog together before
   * anything is written, so a combination the deployment cannot serve leaves
   * the session without routes rather than with two good roles and one that
   * fails on its first delegation.
   *
   * The write is a first-set-once claim, judged against the session's final
   * record: the same combination as the recorded set succeeds idempotently
   * without another event, and any other combination throws a `crew/conflict`
   * RemoteError that leaves the recorded set unchanged. A racing loser of the
   * pre-validation check re-reads the record after validation, so it settles
   * by the same comparison instead of trusting a stale guard result.
   * @param agent - live Agent receiving the routes.
   * @param selection - source combination identity, name, and complete routes.
   * @param signal - carrier cancellation, owning the call until the routes land.
   * @returns whether this call appended the event; an idempotent replay returns false.
   * @throws a `crew/conflict` RemoteError when the session already records a
   *   different combination; the recorded set is untouched.
   */
  @Remote('selectRoutes')
  async selectRoutes(
    agent: Agent,
    selection: CrewRouteSelection,
    signal: AbortSignal,
  ): Promise<boolean> {
    const session = agent.session
    const recorded = crewRoutesOf(this.handle, session)
    if (recorded.routes !== null) {
      if (sameSelection(recorded, selection)) return false
      throw new RemoteError('crew/conflict', 'This session already runs another model combination', {
        sessionId: session.id,
        recordedPresetId: recorded.presetId,
        attemptedPresetId: selection.presetId,
      })
    }
    for (const role of CREW_ROLES) {
      await this.assertRoute(selection.routes[role], signal)
    }
    // Another call may have recorded its set while this one validated: settle
    // the race by the final record, never by the earlier guard result.
    const final = crewRoutesOf(this.handle, session)
    if (final.routes !== null) {
      if (sameSelection(final, selection)) return false
      throw new RemoteError('crew/conflict', 'This session already runs another model combination', {
        sessionId: session.id,
        recordedPresetId: final.presetId,
        attemptedPresetId: selection.presetId,
      })
    }
    recordCrewRoutes(this.handle, session, {
      presetId: selection.presetId,
      presetName: selection.presetName,
      routes: {
        worker: { ...selection.routes.worker },
        planner: { ...selection.routes.planner },
        reviewer: { ...selection.routes.reviewer },
      },
    })
    return true
  }

  /**
   * Replace one role's route after a failed delegation made it unusable.
   *
   * The other two roles keep theirs, and the session stops matching its source
   * combination. No delegation is retried here: the caller decides whether to
   * resume the settled child, because an automatic retry could repeat whatever
   * the failed request had already done.
   * @param agent - live Agent whose role route changes.
   * @param role - role being repaired.
   * @param route - the route that role now uses.
   * @param signal - carrier cancellation, owning the call until the route lands.
   * @returns the route the session now records for that role.
   */
  @Remote('replaceRole')
  async replaceRole(
    agent: Agent,
    role: CrewRole,
    route: CrewRoleRoute,
    signal: AbortSignal,
  ): Promise<CrewRoleRoute> {
    const session = agent.session
    if (crewRoutesOf(this.handle, session).routes === null) {
      throw new Error(`crew session "${session.id}" has no recorded routes; select a combination first`)
    }
    await this.assertRoute(route, signal)
    replaceCrewRoleRoute(session, role, route)
    return { ...route }
  }

  /** The route set one session records, or undefined when it recorded none. */
  private recorded(session: Session): CrewRoutesState | undefined {
    const state = this.handle.stateOf(session)
    return state.routes === null ? undefined : state
  }

  /**
   * Reject a route the deployment's catalog cannot serve.
   * @param route - provider, model, and effort to verify together.
   * @param signal - cancellation for the catalog read.
   */
  private async assertRoute(route: CrewRoleRoute, signal: AbortSignal): Promise<void> {
    await this.ctx.llm.resolveCallConfig({
      provider: route.provider,
      model: route.model,
      reasoningEffort: ReasoningEffortId(route.reasoningEffort),
    }, signal)
  }
}

/** The LLM runtime this service reads the catalog from. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session-scoped crew formation ownership. */
    crewFormation: CrewFormation
    /** LLM runtime resolved for catalog validation. */
    llm: LlmRuntime
  }
}

/**
 * Whether one combination matches the set a session already records: the
 * identity and every role's exact route must agree, so an idempotent replay is
 * the same pick, never a different combination that happens to share a name.
 * @param recorded - the session's final record.
 * @param selection - the combination the caller wants on the session.
 * @returns whether the two name the same combination with identical routes.
 */
function sameSelection(
  recorded: CrewRoutesState,
  selection: CrewRouteSelection,
): boolean {
  if (recorded.presetId !== selection.presetId || recorded.presetName !== selection.presetName) return false
  if (recorded.routes === null) return false
  const recordedRoutes = recorded.routes
  return CREW_ROLES.every(role =>
    recordedRoutes[role].provider === selection.routes[role].provider
    && recordedRoutes[role].model === selection.routes[role].model
    && recordedRoutes[role].reasoningEffort === selection.routes[role].reasoningEffort)
}

export default CrewFormation
