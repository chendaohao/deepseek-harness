// @vitest-environment jsdom
/**
 * The crew combination library's pure edits: drafts, completeness, ids, and the
 * served-route fold the editor seeds from. The switch itself no longer exists —
 * a combination is a template a session copies, not a write into the roles.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  createServedRouteSet, defaultPreset, draftComplete, draftFromPreset, emptyPresets, newPresetId,
  removePreset, routesFromDraft, upsertPreset,
} from '../src/client/crew-presets.ts'
import type { CrewRoleRef, RoutePreset, RoutePresetRoute } from '../src/client/crew-presets.ts'
import type { CrewRoute } from '../src/client/crew-routes.ts'
import type { RouteSettings } from '../src/client/route-settings.ts'

const WORKER = 'subagent-worker-route-settings'
const PLANNER = 'subagent-planner-route-settings'
const REVIEWER = 'subagent-reviewer-route-settings'

const ROUTE: RouteSettings = { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' }
const OTHER: RouteSettings = { provider: 'beta', model: 'beta-pro', reasoningEffort: 'low' }
const THIRD: RouteSettings = { provider: 'gamma', model: 'gamma-pro', reasoningEffort: 'max' }

const ROLES: readonly CrewRoleRef[] = [
  { namespace: WORKER, nameKey: 'crewRoleWorker' },
  { namespace: PLANNER, nameKey: 'crewRolePlanner' },
  { namespace: REVIEWER, nameKey: 'crewRoleReviewer' },
]

const THREE: readonly RoutePresetRoute[] = [
  { namespace: WORKER, ...ROUTE },
  { namespace: PLANNER, ...OTHER },
  { namespace: REVIEWER, ...THIRD },
]

/** One combination over the three crew namespaces. */
function preset(id: string, name: string, routes: readonly RoutePresetRoute[] = THREE): RoutePreset {
  return { id, name, routes: [...routes] }
}

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

describe('draftFromPreset', () => {
  it('seeds every role from a combination that covers them all', () => {
    const served = new Map([[WORKER, ROUTE], [PLANNER, OTHER], [REVIEWER, THIRD]])
    const drafts = draftFromPreset(preset('a', 'All'), ROLES, served)
    expect(drafts.get(WORKER)).toEqual(ROUTE)
    expect(drafts.get(PLANNER)).toEqual(OTHER)
    expect(drafts.get(REVIEWER)).toEqual(THIRD)
  })

  it('falls back to the served route for a role the combination omits', () => {
    // A stored set that names only the worker still opens on a complete draft,
    // so the page is saveable instead of starting incomplete.
    const store = { ...preset('a', 'Worker only', [{ namespace: WORKER, ...ROUTE }]) }
    const served = new Map([[WORKER, ROUTE], [PLANNER, OTHER], [REVIEWER, THIRD]])
    const drafts = draftFromPreset(store, ROLES, served)
    expect(drafts.get(PLANNER)).toEqual(OTHER)
    expect(drafts.get(REVIEWER)).toEqual(THIRD)
  })

  it('leaves a role with neither a stored nor a served route out of the draft', () => {
    const drafts = draftFromPreset(undefined, ROLES, new Map([[WORKER, ROUTE]]))
    expect([...drafts.keys()]).toEqual([WORKER])
  })
})

describe('draftComplete', () => {
  it('accepts a draft naming every role', () => {
    const served = new Map([[WORKER, ROUTE], [PLANNER, OTHER], [REVIEWER, THIRD]])
    expect(draftComplete(draftFromPreset(preset('a', 'All'), ROLES, served), ROLES)).toBe(true)
  })

  it('rejects a draft missing one role', () => {
    const drafts = draftFromPreset(undefined, ROLES, new Map([[WORKER, ROUTE], [PLANNER, OTHER]]))
    expect(draftComplete(drafts, ROLES)).toBe(false)
  })

  it('rejects an empty draft even when no role is served', () => {
    // A block with no served role has nothing to save; treating that as
    // complete would offer a button that writes an empty combination.
    expect(draftComplete(new Map(), [])).toBe(false)
  })

  it('rejects a draft whose role lost a field', () => {
    const drafts = new Map([[WORKER, { provider: 'alpha', model: '', reasoningEffort: 'high' }]])
    expect(draftComplete(drafts, [ROLES[0] as CrewRoleRef])).toBe(false)
  })
})

describe('routesFromDraft', () => {
  it('returns one route per role, in roster order', () => {
    const served = new Map([[WORKER, ROUTE], [PLANNER, OTHER], [REVIEWER, THIRD]])
    const drafts = draftFromPreset(preset('a', 'All'), ROLES, served)
    expect(routesFromDraft(drafts, ROLES)).toEqual([
      { namespace: WORKER, ...ROUTE },
      { namespace: PLANNER, ...OTHER },
      { namespace: REVIEWER, ...THIRD },
    ])
  })

  it('skips a role missing from the draft', () => {
    const drafts = draftFromPreset(undefined, ROLES, new Map([[WORKER, ROUTE]]))
    expect(routesFromDraft(drafts, ROLES)).toEqual([{ namespace: WORKER, ...ROUTE }])
  })
})

describe('newPresetId', () => {
  it('starts at one on an empty list', () => {
    expect(newPresetId([])).toBe('preset-1')
  })

  it('skips every id already stored', () => {
    expect(newPresetId([preset('preset-1', 'A'), preset('preset-2', 'B')])).toBe('preset-3')
  })

  it('fills the first gap rather than counting past it', () => {
    expect(newPresetId([preset('preset-2', 'B')])).toBe('preset-1')
  })
})

describe('upsertPreset', () => {
  it('appends an unseen combination', () => {
    expect(upsertPreset([preset('a', 'A')], preset('b', 'B')).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('replaces in place, keeping stored order', () => {
    const result = upsertPreset([preset('a', 'A'), preset('b', 'B')], preset('a', 'Renamed'))
    expect(result.map(entry => entry.name)).toEqual(['Renamed', 'B'])
  })
})

describe('removePreset', () => {
  it('drops exactly the named combination', () => {
    expect(removePreset([preset('a', 'A'), preset('b', 'B')], 'a').map(entry => entry.id)).toEqual(['b'])
  })

  it('leaves an unknown id alone', () => {
    expect(removePreset([preset('a', 'A')], 'zzz').map(entry => entry.id)).toEqual(['a'])
  })
})

describe('defaultPreset', () => {
  it('opens on the last used combination', () => {
    const stored = { presets: [preset('a', 'A'), preset('b', 'B')], lastUsedPresetId: 'b' }
    expect(defaultPreset(stored)?.id).toBe('b')
  })

  it('falls back to the first entry when the pointer names nothing stored', () => {
    expect(defaultPreset({ presets: [preset('a', 'A')], lastUsedPresetId: 'gone' })?.id).toBe('a')
  })

  it('has nothing to open on an empty library', () => {
    expect(defaultPreset(emptyPresets())).toBeUndefined()
  })
})

describe('createServedRouteSet', () => {
  it('folds every handle into one set, keeping handle order', () => {
    const worker = role(WORKER, ROUTE)
    const planner = role(PLANNER, OTHER)
    const set = createServedRouteSet([worker.route, planner.route]).getSnapshot()
    expect(set.routes.map(entry => entry.namespace)).toEqual([WORKER, PLANNER])
    expect(set.writable).toBe(true)
    expect(set.blocked).toBeUndefined()
  })

  it('reports a read-only document rather than pretending the roles are writable', () => {
    const worker = role(WORKER, ROUTE, { writable: false })
    const set = createServedRouteSet([worker.route]).getSnapshot()
    expect(set.blocked).toBe('read-only')
  })

  it('reports a running role separately from a read-only document', () => {
    const worker = role(WORKER, ROUTE, { writeRefusal: 'a child is running' })
    expect(createServedRouteSet([worker.route]).getSnapshot().blocked).toBe('locked')
  })

  it('treats a role the Host does not serve as making the set unwritable', () => {
    const worker = role(WORKER, ROUTE)
    const planner = role(PLANNER, OTHER, { status: 'unavailable', value: undefined })
    const set = createServedRouteSet([worker.route, planner.route]).getSnapshot()
    expect(set.routes).toHaveLength(1)
    expect(set.writable).toBe(false)
  })

  it('returns the same snapshot between changes', () => {
    const worker = role(WORKER, ROUTE)
    const source = createServedRouteSet([worker.route])
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })
})
