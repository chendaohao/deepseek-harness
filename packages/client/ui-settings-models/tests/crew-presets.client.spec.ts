// @vitest-environment jsdom
/** Saved crew-route combinations: matching, the one-click switch, and rollback. */

import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  applyRoutes, createServedRouteSet, matchingPreset, newPresetId, removePreset, routeOps, samePresetRoutes,
  snapshotRoutes, upsertPreset,
} from '../src/client/crew-presets.ts'
import type { RoutePreset, RoutePresetRoute } from '../src/client/crew-presets.ts'
import type { CrewRoute } from '../src/client/crew-routes.ts'
import type { RouteSettings } from '../src/client/route-settings.ts'

const WORKER = 'subagent-worker-route-settings'
const PLANNER = 'subagent-planner-route-settings'
const REVIEWER = 'subagent-reviewer-route-settings'

const ROUTE: RouteSettings = { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' }
const OTHER: RouteSettings = { provider: 'beta', model: 'beta-pro', reasoningEffort: 'low' }

/** One combination over the three crew namespaces. */
function preset(id: string, name: string, routes: readonly RoutePresetRoute[]): RoutePreset {
  return { id, name, routes: [...routes] }
}

const THIRD: RouteSettings = { provider: 'gamma', model: 'gamma-pro', reasoningEffort: 'max' }

const THREE: readonly RoutePresetRoute[] = [
  { namespace: WORKER, ...ROUTE },
  { namespace: PLANNER, ...OTHER },
  { namespace: REVIEWER, ...THIRD },
]

/** A scope over one mutable snapshot, recording every queued mutation. */
function scopeWith(value: RouteSettings, overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<RouteSettings> = {
    status: 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    writeRefusal: undefined,
    writeFailure: undefined,
    mode: 'host',
    ...overrides,
  }
  const mutate = vi.fn<(ops: unknown) => Promise<boolean>>(() => Promise.resolve(true))
  const scope: ConfigForm<RouteSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { scope, mutate }
}

/** One role handle over a scripted scope. */
function role(namespace: string, value: RouteSettings, overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {}) {
  const { scope, mutate } = scopeWith(value, overrides)
  const route: CrewRoute = { namespace, nameKey: 'crewRoleWorker', scope }
  return { scope, mutate, route }
}

describe('snapshotRoutes', () => {
  it('copies each served role into a stored route', () => {
    const served = [{ namespace: WORKER, value: ROUTE }]
    expect(snapshotRoutes(served)).toEqual([{ namespace: WORKER, ...ROUTE }])
  })

  it('detaches the stored copy from the served value', () => {
    const served = [{ namespace: WORKER, value: { ...ROUTE } }]
    const [stored] = snapshotRoutes(served)
    served[0]!.value.provider = 'changed'
    expect(stored!.provider).toBe('alpha')
  })
})

describe('matchingPreset', () => {
  const served = [
    { namespace: WORKER, value: ROUTE },
    { namespace: PLANNER, value: OTHER },
    { namespace: REVIEWER, value: THIRD },
  ]

  it('matches the combination describing every served role', () => {
    const stored = [preset('a', 'A', THREE)]
    expect(matchingPreset(stored, served)?.id).toBe('a')
  })

  it('reports a custom set when one role differs', () => {
    const stored = [preset('a', 'A', THREE)]
    expect(matchingPreset(stored, [...served.slice(0, 2), { namespace: REVIEWER, value: OTHER }]))
      .toBeUndefined()
  })

  it('does not match a combination that omits a served role', () => {
    const stored = [preset('a', 'A', THREE.slice(0, 2))]
    expect(matchingPreset(stored, served)).toBeUndefined()
  })

  it('matches on the roles both describe when the combination names an extra one', () => {
    const stored = [preset('a', 'A', [...THREE, { namespace: 'ns-extra', ...ROUTE }])]
    expect(matchingPreset(stored, served)?.id).toBe('a')
  })

  it('matches nothing while no role is served', () => {
    expect(matchingPreset([preset('a', 'A', THREE)], [])).toBeUndefined()
  })
})

describe('routeOps', () => {
  it('sends only the fields that differ', () => {
    expect(routeOps(ROUTE, { ...ROUTE, model: 'alpha-pro' }))
      .toEqual([{ op: 'set', path: ['model'], value: 'alpha-pro' }])
  })

  it('sends nothing when the role already matches', () => {
    expect(routeOps(ROUTE, ROUTE)).toEqual([])
  })

  it('sends the provider before the model and the effort', () => {
    expect(routeOps(ROUTE, OTHER).map(op => op.path[0]))
      .toEqual(['provider', 'model', 'reasoningEffort'])
  })
})

describe('applyRoutes', () => {
  it('writes every role that differs', async () => {
    const worker = role(WORKER, OTHER)
    const planner = role(PLANNER, THIRD)
    const outcome = await applyRoutes([worker.route, planner.route], THREE)
    expect(outcome).toEqual({ kind: 'applied' })
    expect(worker.mutate).toHaveBeenCalledOnce()
    expect(planner.mutate).toHaveBeenCalledOnce()
  })

  it('leaves a role alone when it already carries the route', async () => {
    const worker = role(WORKER, ROUTE)
    const outcome = await applyRoutes([worker.route], THREE)
    expect(outcome).toEqual({ kind: 'applied' })
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('refuses the whole set before writing when a role is locked', async () => {
    const worker = role(WORKER, OTHER)
    const planner = role(PLANNER, OTHER, { writeRefusal: 'a child is running' })
    const outcome = await applyRoutes([worker.route, planner.route], THREE)
    expect(outcome).toEqual({ kind: 'locked', namespaces: [PLANNER] })
    expect(worker.mutate).not.toHaveBeenCalled()
    expect(planner.mutate).not.toHaveBeenCalled()
  })

  it('refuses the whole set when the document is read-only', async () => {
    const worker = role(WORKER, OTHER, { writable: false })
    const outcome = await applyRoutes([worker.route], THREE)
    expect(outcome).toEqual({ kind: 'read-only' })
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('refuses the whole set when a role namespace is not served', async () => {
    const worker = role(WORKER, OTHER, { status: 'unavailable' })
    const outcome = await applyRoutes([worker.route], THREE)
    expect(outcome).toEqual({ kind: 'read-only' })
  })

  it('refuses the whole set when the page serves no role the combination names', async () => {
    const outcome = await applyRoutes([], THREE)
    expect(outcome).toEqual({ kind: 'read-only' })
  })

  it('puts the roles already written back when one is refused', async () => {
    const worker = role(WORKER, OTHER)
    const failed = vi.fn()
      .mockResolvedValueOnce(false)
    const planner = role(PLANNER, THIRD)
    const refusing: CrewRoute = { ...planner.route, scope: { ...planner.scope, mutate: failed } }
    const outcome = await applyRoutes([worker.route, refusing], THREE)
    expect(outcome).toEqual({ kind: 'rolled-back', namespace: PLANNER })
    // One forward write, then one restoral of the same three fields.
    expect(worker.mutate).toHaveBeenCalledTimes(2)
    // The worker started on OTHER and was moved to ROUTE, so its restoral is OTHER.
    expect(worker.mutate.mock.calls[1]![0]).toEqual([
      { op: 'set', path: ['provider'], value: 'beta' },
      { op: 'set', path: ['model'], value: 'beta-pro' },
      { op: 'set', path: ['reasoningEffort'], value: 'low' },
    ])
  })

  it('restores in reverse order so an earlier role settles last', async () => {
    const order: string[] = []
    const worker = role(WORKER, OTHER)
    const planner = role(PLANNER, THIRD)
    const reviewer = role(REVIEWER, OTHER, { writable: true })
    const refusing: CrewRoute = {
      ...reviewer.route,
      scope: {
        ...reviewer.scope,
        mutate: () => { order.push(REVIEWER); return Promise.resolve(false) },
      },
    }
    const tracking = (entry: ReturnType<typeof role>, namespace: string): CrewRoute => ({
      ...entry.route,
      scope: {
        ...entry.scope,
        mutate: () => { order.push(namespace); return Promise.resolve(true) },
      },
    })
    await applyRoutes([tracking(worker, WORKER), tracking(planner, PLANNER), refusing], THREE)
    // Forward in table order, restoral in reverse so the first role settles last.
    expect(order).toEqual([WORKER, PLANNER, REVIEWER, PLANNER, WORKER])
  })

  it('skips a page role the combination does not name', async () => {
    const worker = role(WORKER, OTHER)
    const outcome = await applyRoutes([worker.route], [{ namespace: PLANNER, ...ROUTE }])
    expect(outcome).toEqual({ kind: 'read-only' })
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('skips a ready role whose value has not landed', async () => {
    const worker = role(WORKER, OTHER, { value: undefined })
    const outcome = await applyRoutes([worker.route], THREE)
    expect(outcome).toEqual({ kind: 'applied' })
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('ignores a combination route for a role the page does not serve', async () => {
    const worker = role(WORKER, OTHER)
    const outcome = await applyRoutes([worker.route], [...THREE, { namespace: 'ns-extra', ...OTHER }])
    expect(outcome).toEqual({ kind: 'applied' })
    expect(worker.mutate).toHaveBeenCalledOnce()
  })
})

describe('preset list edits', () => {
  it('picks an id no stored combination uses', () => {
    expect(newPresetId([])).toBe('preset-1')
    expect(newPresetId([preset('preset-2', 'A', THREE)])).toBe('preset-1')
    expect(newPresetId([preset('preset-1', 'A', THREE), preset('preset-2', 'B', THREE)])).toBe('preset-3')
  })

  it('appends a new combination', () => {
    const next = upsertPreset([preset('a', 'A', THREE)], preset('b', 'B', THREE))
    expect(next.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('replaces the combination carrying the same id in place', () => {
    const next = upsertPreset([preset('a', 'A', THREE)], preset('a', 'Renamed', THREE))
    expect(next.map(entry => entry.name)).toEqual(['Renamed'])
  })

  it('keeps the other combinations untouched when one is replaced', () => {
    const next = upsertPreset([preset('a', 'A', THREE), preset('b', 'B', THREE)], preset('b', 'Renamed', THREE))
    expect(next.map(entry => entry.name)).toEqual(['A', 'Renamed'])
  })

  it('drops one combination', () => {
    const next = removePreset([preset('a', 'A', THREE), preset('b', 'B', THREE)], 'a')
    expect(next.map(entry => entry.id)).toEqual(['b'])
  })
})

describe('samePresetRoutes', () => {
  it('is true for the same routes in another order', () => {
    expect(samePresetRoutes(THREE, [...THREE].reverse())).toBe(true)
  })

  it('is false when one route differs', () => {
    expect(samePresetRoutes(THREE, [...THREE.slice(1), { namespace: WORKER, ...OTHER }])).toBe(false)
  })

  it('is false when the lengths differ', () => {
    expect(samePresetRoutes(THREE, THREE.slice(0, 2))).toBe(false)
  })
})

describe('createServedRouteSet', () => {
  it('folds every ready role into one set', () => {
    const source = createServedRouteSet([role(WORKER, ROUTE).route, role(PLANNER, OTHER).route])
    const served = source.getSnapshot()
    expect(served.routes.map(entry => entry.namespace)).toEqual([WORKER, PLANNER])
    expect(served.writable).toBe(true)
    expect(served.blocked).toBeUndefined()
  })

  it('reports a locked set when one role publishes a refusal', () => {
    const source = createServedRouteSet([role(WORKER, ROUTE, { writeRefusal: 'running' }).route])
    expect(source.getSnapshot().blocked).toBe('locked')
  })

  it('reports read-only when a role is not ready', () => {
    const source = createServedRouteSet([role(WORKER, ROUTE, { status: 'loading', value: undefined }).route])
    expect(source.getSnapshot().blocked).toBe('read-only')
  })

  it('reports read-only when the Host serves fewer roles than the page renders', () => {
    const source = createServedRouteSet([
      role(WORKER, ROUTE, { status: 'unavailable' }).route,
      role(PLANNER, ROUTE).route,
    ])
    expect(source.getSnapshot().blocked).toBe('read-only')
  })

  it('returns the same snapshot until a role moves', () => {
    const source = createServedRouteSet([role(WORKER, ROUTE).route])
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })

  it('notifies a subscriber when a role handle moves', () => {
    let notify: () => void = () => {}
    const snapshot: ConfigFormSnapshot<RouteSettings> = {
      status: 'ready', value: ROUTE, base: undefined, user: undefined, revision: 1,
      writable: true, writeRefusal: undefined, writeFailure: undefined, mode: 'host',
    }
    const scope: ConfigForm<RouteSettings> = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { notify = listener; return () => {} },
      mutate: () => Promise.resolve(true),
      set: () => Promise.resolve(true),
      unset: () => Promise.resolve(true),
    }
    const source = createServedRouteSet([{ namespace: WORKER, nameKey: 'crewRoleWorker', scope }])
    const listener = vi.fn()
    const dispose = source.subscribe(listener)
    snapshot.value = OTHER
    notify()
    expect(listener).toHaveBeenCalled()
    dispose()
  })
})
