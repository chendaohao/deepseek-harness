// @vitest-environment jsdom
/**
 * The crew combination editor: pick a combination, pick a role, edit that
 * role. The editor only writes the combination library — never a role's route
 * namespace — which is what keeps it usable while a role is running.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CrewRouteSection, type CrewRouteCopy } from '../src/client/CrewRouteSection.tsx'
import type { RoutePreset, RoutePresetsSettings } from '../src/client/crew-presets.ts'
import type { CrewRoleNameKey } from '../src/client/crew-routes.ts'
import type { RouteCatalogState, RouteSettings } from '../src/client/route-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const COPY: CrewRouteCopy = {
  title: t('crewRouteTitle'),
  intro: t('crewRouteIntro'),
  provider: t('crewRouteProvider'),
  model: t('crewRouteModel'),
  effort: t('crewRouteEffort'),
  locked: t('crewRouteLocked'),
  refused: t('crewRouteRefused'),
  conflict: t('crewRouteConflict'),
  reset: t('crewRouteReset'),
  presetLabel: t('crewPresetLabel'),
  presetNew: t('crewPresetNew'),
  presetSave: t('crewPresetSave'),
  presetRole: t('crewPresetRole'),
  presetName: t('crewPresetName'),
  presetNamePlaceholder: t('crewPresetNamePlaceholder'),
  presetConfirm: t('crewPresetConfirm'),
  presetDelete: t('crewPresetDelete'),
  presetSaved: t('crewPresetSaved'),
  presetDeleted: t('crewPresetDeleted'),
  presetIncomplete: t('crewPresetIncomplete'),
  presetReadOnly: t('crewPresetReadOnly'),
  presetRefused: t('crewPresetRefused'),
}

const WORKER = 'subagent-worker-route-settings'
const PLANNER = 'subagent-planner-route-settings'
const FAST: RouteSettings = { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' }
const SLOW: RouteSettings = { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' }

const CATALOG: ModelCatalog = {
  default: { provider: 'alpha', model: 'alpha-fast' },
  routableProviders: ['alpha'],
  groups: [{
    id: 'alpha',
    name: 'Alpha',
    models: [
      { id: 'alpha-fast', name: 'Alpha Fast', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      { id: 'alpha-pro', name: 'Alpha Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ],
  }],
  failures: [],
}

/** One route scope over a fixed snapshot, recording every mutation. */
function routeScope(value: RouteSettings | undefined, overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<RouteSettings> = {
    status: 'ready', value, base: undefined, user: undefined, revision: 1,
    writable: true, writeRefusal: undefined, writeFailure: undefined, mode: 'host',
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

/** One preset scope over a fixed list, recording every mutation. */
function presetScope(
  presets: RoutePreset[],
  overrides: Partial<ConfigFormSnapshot<RoutePresetsSettings>> = {},
  lastUsedPresetId?: string,
) {
  const snapshot: ConfigFormSnapshot<RoutePresetsSettings> = {
    status: 'ready',
    value: { presets, ...lastUsedPresetId === undefined ? {} : { lastUsedPresetId } },
    base: undefined, user: undefined, revision: 1,
    writable: true, writeRefusal: undefined, writeFailure: undefined, mode: 'host',
    ...overrides,
  }
  const mutate = vi.fn<(ops: unknown) => Promise<boolean>>(() => Promise.resolve(true))
  const scope: ConfigForm<RoutePresetsSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { scope, mutate }
}

/**
 * A preset scope whose write fails and publishes the failure the way the real
 * controller does: the rejected write settles first, then the form reports it.
 */
function failingPresetScope(presets: RoutePreset[], failure: 'refused' | 'conflict') {
  const snapshot: ConfigFormSnapshot<RoutePresetsSettings> = {
    status: 'ready', value: { presets }, base: undefined, user: undefined, revision: 1,
    writable: true, writeRefusal: undefined, writeFailure: undefined, mode: 'host',
  }
  const mutate = vi.fn(async () => {
    snapshot.writeFailure = failure
    return false
  })
  const scope: ConfigForm<RoutePresetsSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { scope, mutate }
}

const ROLE_NAMES: readonly CrewRoleNameKey[] = ['crewRoleWorker', 'crewRolePlanner']

/** Mount the block with the served roles and one preset handle. */
function mount(
  routes: readonly { namespace: string; value: RouteSettings | undefined }[],
  presets: ConfigForm<RoutePresetsSettings>,
) {
  const handles = routes.map((route) => {
    const worker = routeScope(route.value)
    const nameKey = ROLE_NAMES[routes.indexOf(route)] ?? 'crewRoleWorker'
    return { handle: worker, route: { namespace: route.namespace, nameKey, scope: worker.scope } }
  })
  const catalog: RouteCatalogState = { value: CATALOG, status: 'ready' }
  render(
    <CrewRouteSection
      block={{
        routes: handles.map(entry => entry.route),
        catalog: createSnapshotStore<RouteCatalogState>(catalog),
        presets,
        loadCatalog: () => {},
      }}
      copy={COPY}
      t={t}
    />,
  )
  return handles
}

/** The control a role label carries once the role name replaces its placeholder. */
const roleLabel = (template: string, role = en.crewRoleWorker): string =>
  template.replaceAll('{role}', role)

const picker = (): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(COPY.presetLabel)
const modelControl = (role?: string): HTMLSelectElement =>
  screen.getByLabelText<HTMLSelectElement>(roleLabel(COPY.model, role))
const rolePicker = (): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(COPY.presetRole)
const nameField = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(COPY.presetName)

describe('the combination editor', () => {
  it('draws nothing while the Host serves no preset namespace', () => {
    mount([{ namespace: WORKER, value: FAST }], presetScope([], { status: 'unavailable' }).scope)
    expect(screen.queryByLabelText(COPY.presetLabel)).toBeNull()
  })

  it('opens on the last used combination', () => {
    const stored: RoutePreset[] = [
      { id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] },
      { id: 'b', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] },
    ]
    mount([{ namespace: WORKER, value: FAST }], presetScope(stored, {}, 'b').scope)
    expect(picker().value).toBe('b')
    expect(nameField().value).toBe('Slow')
  })

  it('falls back to the first combination when the last used one was deleted', () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }]
    mount([{ namespace: WORKER, value: FAST }], presetScope(stored, {}, 'gone').scope)
    expect(picker().value).toBe('a')
    expect(nameField().value).toBe('Fast')
  })

  it('seeds a new combination from the routes the roles carry', () => {
    mount([{ namespace: WORKER, value: SLOW }], presetScope([]).scope)
    expect(nameField().value).toBe('')
    // The draft opened on the served route, so saving is one name away rather
    // than re-picking a working route.
    expect(modelControl().value).toBe('alpha-pro')
  })

  it('saves the complete draft without writing any role namespace', async () => {
    const stored = presetScope([])
    const handles = mount([{ namespace: WORKER, value: FAST }], stored.scope)
    fireEvent.change(nameField(), { target: { value: 'Fast work' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(stored.mutate).toHaveBeenCalled() })
    expect(stored.mutate.mock.calls[0]?.[0]).toEqual([
      { op: 'set', path: ['presets'], value: [{ id: 'preset-1', name: 'Fast work', routes: [{ namespace: WORKER, ...FAST }] }] },
    ])
    // The role's own namespace is untouched: editing the library is what makes
    // the page usable while a role is running.
    expect(handles[0]?.handle.mutate).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.getByText(COPY.presetSaved)).toBeTruthy() })
  })

  it('keeps a role draft when the selected role switches', () => {
    const stored: RoutePreset[] = [{
      id: 'a',
      name: 'Both',
      routes: [{ namespace: WORKER, ...FAST }, { namespace: PLANNER, ...FAST }],
    }]
    mount([{ namespace: WORKER, value: FAST }, { namespace: PLANNER, value: FAST }], presetScope(stored).scope)
    fireEvent.change(modelControl(), { target: { value: 'alpha-pro' } })
    expect(modelControl().value).toBe('alpha-pro')

    fireEvent.change(rolePicker(), { target: { value: PLANNER } })
    // The planner kept its own draft rather than inheriting the worker's edit.
    expect(modelControl(en.crewRolePlanner).value).toBe('alpha-fast')

    fireEvent.change(rolePicker(), { target: { value: WORKER } })
    expect(modelControl().value).toBe('alpha-pro')
  })

  it('refuses to save a combination missing a role', async () => {
    const stored = presetScope([])
    mount([{ namespace: WORKER, value: FAST }, { namespace: PLANNER, value: undefined }], stored.scope)
    fireEvent.change(nameField(), { target: { value: 'Partial' } })
    // The planner has no draft, so the set is incomplete and the save button
    // stays disabled rather than writing a combination the Host would reject.
    expect(screen.getByRole('button', { name: COPY.presetConfirm }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(COPY.presetIncomplete)).toBeTruthy()
  })

  it('reports a refused write instead of claiming the save landed', async () => {
    const stored = failingPresetScope([], 'refused')
    mount([{ namespace: WORKER, value: FAST }], stored.scope)
    fireEvent.change(nameField(), { target: { value: 'Fast work' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(screen.getByText(COPY.presetRefused)).toBeTruthy() })
    expect(screen.queryByText(COPY.presetSaved)).toBeNull()
  })

  it('reports a stale page as a conflict rather than a refusal', async () => {
    const stored = failingPresetScope([], 'conflict')
    mount([{ namespace: WORKER, value: FAST }], stored.scope)
    fireEvent.change(nameField(), { target: { value: 'Fast work' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(screen.getByText(COPY.conflict)).toBeTruthy() })
  })

  it('deletes the combination being edited and clears a pointer that named it', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }]
    const handle = presetScope(stored, {}, 'a')
    mount([{ namespace: WORKER, value: FAST }], handle.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetDelete }))
    await waitFor(() => { expect(handle.mutate).toHaveBeenCalled() })
    expect(handle.mutate.mock.calls[0]?.[0]).toEqual([
      { op: 'set', path: ['presets'], value: [] },
      { op: 'unset', path: ['lastUsedPresetId'] },
    ])
    await waitFor(() => { expect(screen.getByText(COPY.presetDeleted)).toBeTruthy() })
  })

  it('disables the editor when the combination list is read-only', () => {
    mount([{ namespace: WORKER, value: FAST }], presetScope([], { writable: false }).scope)
    expect(picker().disabled).toBe(true)
    expect(nameField().disabled).toBe(true)
    expect(screen.getByText(COPY.presetReadOnly)).toBeTruthy()
  })
})
