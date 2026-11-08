/**
 * The crew route combination library: named triples of the three role routes,
 * edited as data.
 *
 * A combination is a template, not a switch. Editing one changes only this
 * settings namespace, so the page is never blocked by a role that happens to be
 * running: what a session actually runs was copied onto that session when it
 * started, and this library is where the next session picks from. That
 * separation is why the block no longer writes the role namespaces at all —
 * applying a combination to a live session is the formation service's job.
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CrewRoute } from './crew-routes.ts'
import type { RouteSettings } from './route-settings.ts'

/** Settings namespace the Host's preset row serves. */
export const SUBAGENT_ROUTE_PRESETS_NAMESPACE = 'subagent-route-presets'

/** One role's route inside a stored combination. */
export interface RoutePresetRoute {
  /** Settings namespace of the role this route drives. */
  namespace: string
  /** Registered LLM provider id for that role. */
  provider: string
  /** Provider-owned exact model id for that role. */
  model: string
  /** Adapter-owned reasoning effort for that role. */
  reasoningEffort: string
}

/** One named combination of role routes. */
export interface RoutePreset {
  /** Stable identity the page uses to look the combination up; never parsed. */
  id: string
  /** Name shown in the combination picker. */
  name: string
  /** The roles this combination covers. */
  routes: RoutePresetRoute[]
}

/** Stored combinations, as the Host serves them. */
export interface RoutePresetsSettings {
  /** Every saved combination, in stored order. */
  presets: RoutePreset[]
  /**
   * Combination the new-session picker opens on, when one is stored. Absence
   * means the picker offers its first combination; a value naming a combination
   * that no longer exists is treated the same way.
   */
  lastUsedPresetId?: string
}

/**
 * One role's draft while the page edits a combination.
 *
 * A draft is per role and independent of every other role's, so switching the
 * selected role never loses unsaved edits and saving requires all three.
 */
export interface RoleDraft {
  /** Selected provider id. */
  provider: string
  /** Selected model id. */
  model: string
  /** Selected reasoning effort id. */
  reasoningEffort: string
}

/** One role's identity in the block: its namespace and its label key. */
export interface CrewRoleRef {
  /** Settings namespace the role's route row serves. */
  namespace: string
  /** Locale key naming the role. */
  nameKey: CrewRoute['nameKey']
}

/**
 * The draft a newly selected combination starts from.
 *
 * A combination that covers every role yields those routes. One that omits a
 * role falls back to the role's served default, so the page opens on a complete,
 * saveable set instead of an incomplete one the Host would reject.
 * @param preset - the selected combination, or undefined when none is selected.
 * @param roles - every role the page serves, in display order.
 * @param served - the route each role currently carries.
 * @returns one draft per role, in `roles` order.
 */
export function draftFromPreset(
  preset: RoutePreset | undefined,
  roles: readonly CrewRoleRef[],
  served: ReadonlyMap<string, RouteSettings>,
): Map<string, RoleDraft> {
  const stored = new Map((preset?.routes ?? []).map(route => [route.namespace, route]))
  const drafts = new Map<string, RoleDraft>()
  for (const role of roles) {
    const route = stored.get(role.namespace)
    const fallback = served.get(role.namespace)
    if (route !== undefined) {
      drafts.set(role.namespace, {
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      })
      continue
    }
    if (fallback !== undefined) {
      drafts.set(role.namespace, {
        provider: fallback.provider,
        model: fallback.model,
        reasoningEffort: fallback.reasoningEffort,
      })
    }
  }
  return drafts
}

/**
 * Whether a draft covers every role the page serves.
 *
 * The Host requires a combination to be complete: a partial one would fail only
 * after someone picked it for a session, with no way to tell which role was
 * missing.
 * @param drafts - one draft per role being edited.
 * @param roles - every role the page serves.
 * @returns whether saving the draft produces a combination the Host accepts.
 */
export function draftComplete(
  drafts: ReadonlyMap<string, RoleDraft>,
  roles: readonly CrewRoleRef[],
): boolean {
  return roles.length > 0 && roles.every((role) => {
    const draft = drafts.get(role.namespace)
    return draft !== undefined && draft.provider.length > 0 && draft.model.length > 0 && draft.reasoningEffort.length > 0
  })
}

/**
 * The routes a save would store from the current draft.
 * @param drafts - one draft per role being edited.
 * @param roles - every role the page serves, in display order.
 * @returns the stored route list, in role order.
 */
export function routesFromDraft(
  drafts: ReadonlyMap<string, RoleDraft>,
  roles: readonly CrewRoleRef[],
): RoutePresetRoute[] {
  const routes: RoutePresetRoute[] = []
  for (const role of roles) {
    const draft = drafts.get(role.namespace)
    if (draft === undefined) continue
    routes.push({
      namespace: role.namespace,
      provider: draft.provider,
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
    })
  }
  return routes
}

/**
 * The next unused preset id.
 *
 * Ids are positional and parsed by nothing: the page looks a combination up by
 * one, and a stored list someone rewrote by hand keeps working as long as the
 * ids stay distinct.
 * @param presets - the combinations currently stored.
 * @returns an id no stored combination uses.
 */
export function newPresetId(presets: readonly RoutePreset[]): string {
  const used = new Set(presets.map(preset => preset.id))
  let index = 1
  while (used.has(`preset-${String(index)}`)) index += 1
  return `preset-${String(index)}`
}

/**
 * Store one combination, replacing the one that carries the same id.
 * @param presets - the combinations currently stored.
 * @param preset - the combination to store.
 * @returns the new list, in stored order with a new combination appended.
 */
export function upsertPreset(presets: readonly RoutePreset[], preset: RoutePreset): RoutePreset[] {
  const exists = presets.some(candidate => candidate.id === preset.id)
  return exists
    ? presets.map(candidate => candidate.id === preset.id ? preset : candidate)
    : [...presets, preset]
}

/**
 * Drop one combination.
 *
 * The caller also unsets a last-used pointer that named the dropped
 * combination, so the next new-session picker falls back to the first entry
 * instead of pointing at something that no longer exists.
 * @param presets - the combinations currently stored.
 * @param id - identity of the combination to drop.
 * @returns the remaining combinations, in stored order.
 */
export function removePreset(presets: readonly RoutePreset[], id: string): RoutePreset[] {
  return presets.filter(preset => preset.id !== id)
}

/**
 * The combination a new-session picker should open on.
 * @param settings - the stored combination list and its last-used pointer.
 * @returns the last-used combination, or the first stored one, or undefined.
 */
export function defaultPreset(settings: RoutePresetsSettings): RoutePreset | undefined {
  const last = settings.lastUsedPresetId === undefined
    ? undefined
    : settings.presets.find(preset => preset.id === settings.lastUsedPresetId)
  return last ?? settings.presets[0]
}

/**
 * An empty combination list, for a page whose Host serves no preset namespace.
 * @returns settings with no combinations and no last-used pointer.
 */
export function emptyPresets(): RoutePresetsSettings {
  return { presets: [] }
}

/** One role's settings handle plus its identity, as the block renders it. */
export interface CrewRoleForm extends CrewRoleRef {
  /** Reactive handle over the role's Host route namespace, read for defaults only. */
  scope: ConfigForm<RouteSettings>
}

/** One role's route as the page currently serves it. */
export interface ServedRoute {
  /** Settings namespace of the role. */
  namespace: string
  /** The route the Host currently serves for that role. */
  value: RouteSettings
}

/** The served routes of every role the page renders, with what a write would face. */
export interface ServedRouteSet {
  /** One entry per role handle whose namespace the Host serves. */
  routes: readonly ServedRoute[]
  /** Whether every role handle is ready and writable. */
  writable: boolean
  /** The outcome a switch would report before writing anything. */
  blocked: 'locked' | 'read-only' | undefined
}

/** A subscribable set of the served routes, stable between changes. */
export interface ServedRouteSetSource {
  /** Observe a change to any role handle. */
  subscribe: (listener: () => void) => () => void
  /** @returns the current set; the same reference until a role handle moves. */
  getSnapshot: () => ServedRouteSet
}

/**
 * Fold every role handle into one subscribable set.
 *
 * The combination editor reads every role at once to seed a draft, which no
 * single role handle can answer. The fold keeps one snapshot object between
 * changes because the editor subscribes to it the way any React consumer does,
 * and rebuilds it only when a handle actually moves.
 * @param routes - every role the block renders, in display order.
 * @returns the shared set the editor subscribes to.
 */
export function createServedRouteSet(routes: readonly CrewRoute[]): ServedRouteSetSource {
  let cached = derive()
  const listeners = new Set<() => void>()
  // A handle only notifies when its own fact moved, so a notification is the
  // change itself: rebuild and publish rather than compare the rebuild.
  const bump = (): void => {
    cached = derive()
    for (const listener of listeners) listener()
  }
  function derive(): ServedRouteSet {
    const served: ServedRoute[] = []
    let writable = true
    let locked = false
    for (const route of routes) {
      const snapshot = route.scope.getSnapshot()
      if (snapshot.status !== 'ready' || !snapshot.writable) writable = false
      if (snapshot.writeRefusal !== undefined) locked = true
      if (snapshot.value === undefined) continue
      served.push({ namespace: route.namespace, value: snapshot.value })
    }
    // A role the Host does not serve keeps the set from describing a complete
    // combination: a draft seeded from it would name a route this deployment
    // cannot reach.
    if (served.length !== routes.length) writable = false
    return { routes: served, writable, blocked: blockedOf(writable, locked) }
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      // Each subscriber wires its own handles, so a remount after an unmount
      // starts from a clean wiring instead of a second copy of the same rows.
      const detach = routes.map(route => route.scope.subscribe(bump))
      return () => {
        listeners.delete(listener)
        for (const dispose of detach) dispose()
      }
    },
    getSnapshot: () => cached,
  }
}

/**
 * Why a write cannot start, from the two facts the handles published.
 * @param writable - whether every role handle can be written.
 * @param locked - whether one role published a write refusal.
 * @returns the blocking reason, or undefined when a write may start.
 */
function blockedOf(writable: boolean, locked: boolean): ServedRouteSet['blocked'] {
  if (!writable) return 'read-only'
  if (locked) return 'locked'
  return undefined
}
