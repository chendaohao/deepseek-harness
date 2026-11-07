/**
 * Client-safe vocabulary of the crew formation: the roles, one role's route,
 * and the two request payloads the Models page and the new-session picker send.
 *
 * Type-only. The Host service that accepts these lives in `formation.ts`; a
 * browser program reaches them through this subpath so the Remote wire types are
 * published without pulling the Host module graph.
 * @module @deepseek-ai/dsh-crew/types
 */

/** The three delegation roles a crew formation runs on. */
export const CREW_ROLES = ['worker', 'planner', 'reviewer'] as const

/** One crew delegation role. */
export type CrewRole = (typeof CREW_ROLES)[number]

/** One role's exact LLM route. */
export interface CrewRoleRoute {
  /** Registered LLM provider id for that role. */
  provider: string
  /** Provider-owned exact model id for that role. */
  model: string
  /** Adapter-owned reasoning effort for that role. */
  reasoningEffort: string
}

/** Every role's route, complete: a formation runs no role on an inherited route. */
export type CrewSessionRoutes = Readonly<Record<CrewRole, CrewRoleRoute>>

/** One role's route as a surface renders it. */
export interface CrewRoleRouteView extends CrewRoleRoute {
  /** Role the route drives. */
  role: CrewRole
}

/** What a session's formation currently looks like. */
export interface CrewSessionView {
  /** Session whose formation was read. */
  sessionId: string
  /** Source combination identity, or null once a role was replaced. */
  presetId: string | null
  /** Name the source combination carried at selection time. */
  presetName: string | null
  /** Every role's current route, or null when the session recorded none. */
  routes: readonly CrewRoleRouteView[] | null
  /** Roles replaced one at a time after their route failed. */
  replaced: readonly CrewRole[]
}

/** A complete route set copied from one combination. */
export interface CrewRouteSelection {
  /** Identity of the combination this set came from. */
  presetId: string
  /** Name the combination carried at selection time. */
  presetName: string
  /** One complete route per role. */
  routes: { [Role in CrewRole]: CrewRoleRoute }
}
