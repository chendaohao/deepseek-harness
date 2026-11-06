/**
 * The crew delegation roles whose model routes the Models page edits. One entry
 * per role is the single data source: the page derives its rows, their Host
 * settings namespaces, and their role labels from this table, so adding a role
 * changes this list and one locale key and nothing else.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RouteCatalogState, RouteSettings } from './route-settings.ts'
import type { RoutePresetsSettings } from './crew-presets.ts'

/** Locale keys naming one role, resolved through the page's `t` seat. */
export type CrewRoleNameKey = 'crewRoleWorker' | 'crewRolePlanner' | 'crewRoleReviewer'

/** One delegation role the Models page edits a route for. */
export interface CrewRole {
  /**
   * Settings namespace the role's route-settings row serves. Spelled here
   * rather than imported: a client package must not depend on a Host package,
   * and the namespace is the profile entry id that mounts the row.
   */
  namespace: string
  /** Locale key naming the role in row labels and control names. */
  nameKey: CrewRoleNameKey
}

/**
 * Every crew role, in display order. The table decides labels and handles, not
 * visibility: the Host serves a role's namespace only when the crew bundle is
 * selected, and a role whose namespace is not served renders no row.
 */
export const CREW_ROLES: readonly CrewRole[] = [
  { namespace: 'subagent-worker-route-settings', nameKey: 'crewRoleWorker' },
  { namespace: 'subagent-planner-route-settings', nameKey: 'crewRolePlanner' },
  { namespace: 'subagent-reviewer-route-settings', nameKey: 'crewRoleReviewer' },
]

/** One role's row: its namespace, its label, and the reactive settings handle. */
export interface CrewRoute {
  /** Settings namespace the row writes into. */
  namespace: string
  /** Locale key naming the role. */
  nameKey: CrewRoleNameKey
  /** Reactive handle over the role's Host route namespace. */
  scope: ConfigForm<RouteSettings>
}

/** The page's injected crew-route face: one handle per role plus the shared catalog. */
export interface CrewRouteBlock {
  /** Every role the page renders a row for, in display order. */
  routes: readonly CrewRoute[]
  /** Shared model catalog the pickers are drawn from. */
  catalog: SnapshotStore<RouteCatalogState>
  /**
   * Saved route combinations. The Host serves this namespace only while the
   * crew bundle composes its preset row, so a deployment without it answers
   * 'unavailable' and the block draws no combination control.
   */
  presets: ConfigForm<RoutePresetsSettings>
  /** Ensure the catalog is loaded. */
  loadCatalog: () => void
}
