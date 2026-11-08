/**
 * One crew session's own model routes for its three delegation roles.
 *
 * The Models page edits named combinations, and a new crew session picks one.
 * The pick has to stay with the session that made it: choosing "deep review"
 * for one conversation must not move a second conversation that is already
 * running, and a later edit of the combination must not reach a session that
 * was started before it. This module owns that per-session fact and the
 * Host-side reads the delegation rows use.
 *
 * The routes are recorded before the session's first turn, and a pick may
 * still be replaced until that turn opens. From then on the session keeps the
 * set it recorded, and a recovery switch records a single role. Both are
 * ordinary session events, so a cold resume replays the same routes without
 * consulting the combination library, and the "logged ⟺ model-visible" rule
 * holds: the routes decide which model each delegation request goes to.
 * @module @deepseek-ai/dsh-crew/routes
 */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  CrewRole,
  CrewRoleRoute,
  CrewRouteSelection,
} from './types.ts'

/** Delegation roles in formation and display order. */
export const CREW_ROLES = ['worker', 'planner', 'reviewer'] as const satisfies readonly CrewRole[]

export type {
  CrewRole,
  CrewRoleRoute,
  CrewRouteSelection,
} from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the complete route set a crew session runs its three delegation
     * roles on, copied from the combination the session picked. Appended
     * before the first turn, so every delegation in that turn already routes
     * from it. A pick made before the first turn replaces an earlier one, and
     * the last such event is the recorded set. Log-only: it carries no
     * `surfaceOp` and never enters model history.
     */
    'crew/routes-selected': {
      /** Identity of the combination this set came from; display metadata only. */
      presetId: string
      /** Name the combination carried at selection time. */
      presetName: string
      /** One complete route per role. */
      routes: { [Role in CrewRole]: CrewRoleRoute }
    }
    /**
     * Records one role's route replaced on its own, after a failed delegation
     * made the original route unusable. Appended without touching the other two
     * roles; the session stops matching its source combination. Log-only.
     */
    'crew/route-replaced': {
      /** Role whose route changed. */
      role: CrewRole
      /** The route that role now uses. */
      route: CrewRoleRoute
    }
  }
}

const roleRouteSchema = zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
  reasoningEffort: zod.string().min(1),
}).strict()

const routesSchema = zod.object({
  worker: roleRouteSchema,
  planner: roleRouteSchema,
  reviewer: roleRouteSchema,
}).strict()

/** What a crew session recorded about its formation. */
export interface CrewRoutesState {
  /** Source combination identity, or null since a single role was replaced. */
  readonly presetId: string | null
  /** Source combination name, kept for display after a role replacement. */
  readonly presetName: string | null
  /** Current route per role; null until the session recorded a set. */
  readonly routes: { [Role in CrewRole]: CrewRoleRoute } | null
  /** Roles replaced one at a time after their recorded route failed. */
  readonly replaced: readonly CrewRole[]
  /** Whether the session appended its first `turn/start`; it fixes the recorded set from then on. */
  readonly firstTurnStarted: boolean
}

const crewRoutesStateSchema: zod.ZodType<CrewRoutesState> = zod.object({
  presetId: zod.string().min(1).nullable(),
  presetName: zod.string().min(1).nullable(),
  routes: routesSchema.nullable(),
  replaced: zod.array(zod.enum(CREW_ROLES)),
  firstTurnStarted: zod.boolean(),
}).strict()

/**
 * Fold the two route events into the state every reader consults.
 *
 * The first set is always accepted, and a later one only while the session
 * opened no turn: a pick supersedes an earlier pick before anything can
 * delegate, and the last set event wins. Once a turn started, a recorded set
 * stands, because a second pick would move delegation targets under work
 * already in flight. A replacement is accepted only for a session that
 * recorded a set, and only for one role, because that is the whole recovery
 * path.
 */
export const crewRoutesProjectionDefinition = {
  key: 'crewRoutes',
  stateVersion: 2,
  stateSchema: crewRoutesStateSchema,
  init: (): CrewRoutesState => ({
    presetId: null,
    presetName: null,
    routes: null,
    replaced: [],
    firstTurnStarted: false,
  }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return state.firstTurnStarted ? state : { ...state, firstTurnStarted: true }
    }
    if (event.type === 'crew/routes-selected') {
      if (state.routes !== null && state.firstTurnStarted) return state
      const { presetId, presetName, routes } = event.data
      const copy = routesSchema.parse(routes)
      return { ...state, presetId, presetName, routes: copy, replaced: [] }
    }
    if (event.type === 'crew/route-replaced') {
      if (state.routes === null) return state
      const { role, route } = event.data
      return {
        ...state,
        // A replaced role no longer matches the named combination, so the
        // session stops claiming one without forgetting where it started.
        presetId: null,
        routes: { ...state.routes, [role]: { ...route } },
        replaced: state.replaced.includes(role) ? state.replaced : [...state.replaced, role],
      }
    }
    return state
  },
} satisfies ProjectionDefinition<'crewRoutes', CrewRoutesState>

/**
 * Read one session's recorded formation.
 * @param handle - registered projection reader.
 * @param session - session whose recorded routes are read.
 * @returns the recorded state; `routes` is null for a session that recorded none.
 */
export function crewRoutesOf(
  handle: Pick<{ stateOf(session: Session): CrewRoutesState }, 'stateOf'>,
  session: Session,
): CrewRoutesState {
  return handle.stateOf(session)
}

/**
 * Record a session's route set.
 *
 * The caller decides whether the session may still pick: the fold keeps the
 * first set recorded once a `turn/start` landed, so an event appended to a
 * started session changes nothing.
 * @param session - crew session receiving the routes.
 * @param selection - source combination identity and the complete route set.
 */
export function recordCrewRoutes(session: Session, selection: CrewRouteSelection): void {
  session.append('crew/routes-selected', selection)
}

/**
 * Replace one role's route, for the recovery path after a failed delegation.
 * @param session - crew session whose role route changes.
 * @param role - role being repaired.
 * @param route - the route that role now uses.
 */
export function replaceCrewRoleRoute(session: Session, role: CrewRole, route: CrewRoleRoute): void {
  session.append('crew/route-replaced', { role, route: { ...route } })
}
