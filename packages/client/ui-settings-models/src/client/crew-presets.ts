/**
 * Saved route combinations for the crew roles, and the one-click switch between
 * them.
 *
 * A combination is a named snapshot of every role's route. Applying one writes
 * the role route namespaces through their own settings forms: the three rows are
 * independent settings entries, so there is no cross-namespace transaction to
 * borrow. The switch therefore gives the whole set one outcome — it preflights
 * every role first, writes only what differs, and puts the written rows back
 * when one is refused, so a half-applied combination never becomes the state.
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
}

/** One role as the page currently sees it: its namespace and its stored route. */
export interface ServedRoute {
  /** Settings namespace of the role. */
  namespace: string
  /** The route the Host currently serves for that role. */
  value: RouteSettings
}

/** What one switch did, in the terms the row reports. */
export type ApplyOutcome =
  | { readonly kind: 'applied' }
  /** Roles that would refuse a write, so nothing was written. */
  | { readonly kind: 'locked'; readonly namespaces: readonly string[] }
  /** Roles the page cannot write at all (unavailable, or a read-only document). */
  | { readonly kind: 'read-only' }
  /** A role refused mid-set; the rows already written were put back. */
  | { readonly kind: 'rolled-back'; readonly namespace: string }

/**
 * The role routes a combination would store right now.
 * @param served - every role the page serves, with its current route.
 * @returns a detached list, in the order given.
 */
export function snapshotRoutes(served: readonly ServedRoute[]): RoutePresetRoute[] {
  return served.map(route => ({
    namespace: route.namespace,
    provider: route.value.provider,
    model: route.value.model,
    reasoningEffort: route.value.reasoningEffort,
  }))
}

/** Whether two routes name the same provider, model, and effort. */
function sameRoute(left: RoutePresetRoute, right: RoutePresetRoute): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * The stored combination matching the routes currently served, if any.
 *
 * A combination is current when it describes every served role and every stored
 * route equals the served one. A combination naming a role this deployment does
 * not serve still matches on the roles both describe, because the extra role is
 * not part of this page's state; a served role the combination omits never
 * matches, since applying it would leave that role at a route the name does not
 * promise.
 * @param presets - every stored combination.
 * @param served - every role the page serves, with its current route.
 * @returns the matching combination, or undefined when none describes this set.
 */
export function matchingPreset(
  presets: readonly RoutePreset[],
  served: readonly ServedRoute[],
): RoutePreset | undefined {
  if (served.length === 0) return undefined
  return presets.find((preset) => {
    const stored = new Map(preset.routes.map(route => [route.namespace, route]))
    return served.every((role) => {
      const route = stored.get(role.namespace)
      return route !== undefined
        && sameRoute(route, { namespace: role.namespace, ...role.value })
    })
  })
}

/**
 * The settings edits one role needs to move from one route to another.
 * @param current - the route the role carries now.
 * @param target - the route to reach.
 * @returns the ops to send, empty when the role already carries it.
 */
export function routeOps(current: RouteSettings, target: RouteSettings): {
  op: 'set'
  path: string[]
  value: string
}[] {
  const ops: { op: 'set'; path: string[]; value: string }[] = []
  if (target.provider !== current.provider) ops.push({ op: 'set', path: ['provider'], value: target.provider })
  if (target.model !== current.model) ops.push({ op: 'set', path: ['model'], value: target.model })
  if (target.reasoningEffort !== current.reasoningEffort) {
    ops.push({ op: 'set', path: ['reasoningEffort'], value: target.reasoningEffort })
  }
  return ops
}

/** One role's write, resolved against the page's handles. */
interface PlannedWrite {
  namespace: string
  scope: ConfigForm<RouteSettings>
  ops: { op: 'set'; path: string[]; value: string }[]
  /** The edits that put this role back on the route this call found. */
  restore: { op: 'set'; path: string[]; value: string }[]
}

/**
 * Move every served role onto the routes a combination names.
 *
 * The switch is all-or-nothing in its outcome, not in its wire calls: the role
 * routes are separate settings namespaces, so each write is its own transaction.
 * Every role is preflighted first — an unwritable document, an unavailable
 * namespace, or a running child that holds a role's route refuses the whole set
 * before anything is sent. If a write is refused anyway, the roles already
 * written go back to the routes this call found them on, so the page never
 * settles on a combination that is half one preset and half another.
 * @param routes - every role handle the page serves.
 * @param target - the route set to reach; a role it omits is left alone.
 * @returns what the switch did.
 */
export async function applyRoutes(
  routes: readonly CrewRoute[],
  target: readonly RoutePresetRoute[],
): Promise<ApplyOutcome> {
  const wanted = new Map(target.map(route => [route.namespace, route]))
  const served = routes.flatMap((route) => {
    const target = wanted.get(route.namespace)
    return target === undefined ? [] : [{ route, target, snapshot: route.scope.getSnapshot() }]
  })
  if (served.length === 0) return { kind: 'read-only' }
  if (served.some(entry => entry.snapshot.status !== 'ready' || !entry.snapshot.writable)) {
    return { kind: 'read-only' }
  }
  const locked = served.filter(entry => entry.snapshot.writeRefusal !== undefined)
  if (locked.length > 0) {
    return { kind: 'locked', namespaces: locked.map(entry => entry.route.namespace) }
  }
  const planned: PlannedWrite[] = []
  for (const { route, target: wantedRoute, snapshot } of served) {
    const current = snapshot.value
    if (current === undefined) continue
    const ops = routeOps(current, wantedRoute)
    if (ops.length === 0) continue
    planned.push({
      namespace: route.namespace,
      scope: route.scope,
      ops,
      restore: routeOps(wantedRoute, current),
    })
  }
  const written: PlannedWrite[] = []
  for (const write of planned) {
    const accepted = await write.scope.mutate(write.ops)
    if (accepted) {
      written.push(write)
      continue
    }
    // Restore only what was written, in reverse: the role written earliest goes
    // back last, so a reader watching the page never settles on a half state.
    for (const done of written.toReversed()) await done.scope.mutate(done.restore)
    return { kind: 'rolled-back', namespace: write.namespace }
  }
  return { kind: 'applied' }
}

/**
 * Whether a stored combination names the same routes as another one.
 * @param left - one combination's routes.
 * @param right - another's.
 * @returns whether every namespace both name carries the same route.
 */
export function samePresetRoutes(
  left: readonly RoutePresetRoute[],
  right: readonly RoutePresetRoute[],
): boolean {
  if (left.length !== right.length) return false
  const stored = new Map(right.map(route => [route.namespace, route]))
  return left.every((route) => {
    const other = stored.get(route.namespace)
    return other !== undefined && sameRoute(route, other)
  })
}

/**
 * The next unused preset id.
 *
 * Ids are positional and unguessable-free on purpose: nothing parses them, the
 * page only looks a preset up by one, and a stored list the user rewrote by hand
 * keeps working as long as the ids stay distinct.
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
 * @param presets - the combinations currently stored.
 * @param id - identity of the combination to drop.
 * @returns the remaining combinations, in stored order.
 */
export function removePreset(presets: readonly RoutePreset[], id: string): RoutePreset[] {
  return presets.filter(preset => preset.id !== id)
}

/** One role's route as the page currently serves it, or the reason it cannot. */
export interface ServedRouteSet {
  /** One entry per role handle, in table order. */
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
 * The combination row reads all roles at once, which no single role handle can
 * answer. The fold keeps one snapshot object between changes because the row
 * subscribes to it the way any React consumer does, and rebuilds it only when a
 * handle actually moves.
 * @param routes - every role the block renders, in display order.
 * @returns the shared set the combination row subscribes to.
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
    // A role the Host does not serve keeps the block from offering a switch: the
    // combination would name a route this deployment cannot reach.
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
 * Why a switch cannot start, from the two facts the handles published.
 * @param writable - whether every role handle can be written.
 * @param locked - whether one role published a write refusal.
 * @returns the blocking reason, or undefined when a switch may start.
 */
function blockedOf(writable: boolean, locked: boolean): ServedRouteSet['blocked'] {
  if (!writable) return 'read-only'
  if (locked) return 'locked'
  return undefined
}
