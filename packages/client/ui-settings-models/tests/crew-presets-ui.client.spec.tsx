// @vitest-environment jsdom
/** The saved-combination row: picking, saving, deleting, and what a switch reports. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CrewRouteSection, type CrewRouteCopy } from '../src/client/CrewRouteSection.tsx'
import type { RoutePreset, RoutePresetsSettings } from '../src/client/crew-presets.ts'
import type { CrewRoute } from '../src/client/crew-routes.ts'
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
  presetCustom: t('crewPresetCustom'),
  presetSave: t('crewPresetSave'),
  presetName: t('crewPresetName'),
  presetNamePlaceholder: t('crewPresetNamePlaceholder'),
  presetConfirm: t('crewPresetConfirm'),
  presetDismiss: t('crewPresetDismiss'),
  presetDelete: t('crewPresetDelete'),
  presetApplied: t('crewPresetApplied'),
  presetSaved: t('crewPresetSaved'),
  presetDeleted: t('crewPresetDeleted'),
  presetLocked: t('crewPresetLocked'),
  presetRolledBack: t('crewPresetRolledBack'),
  presetReadOnly: t('crewPresetReadOnly'),
  presetRefused: t('crewPresetRefused'),
}

const WORKER = 'subagent-worker-route-settings'
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
function routeScope(value: RouteSettings, overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {}) {
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
) {
  const snapshot: ConfigFormSnapshot<RoutePresetsSettings> = {
    status: 'ready', value: { presets }, base: undefined, user: undefined, revision: 1,
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
 * @param presets - the stored list the picker reads.
 * @param failure - the write failure the Host answers with.
 * @returns the handle, its mutation spy, and the mutable snapshot behind it.
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

/** Mount the block with one role and one preset handle. */
function mount(
  roleValue: RouteSettings,
  presets: ConfigForm<RoutePresetsSettings>,
  roleOverrides: Partial<ConfigFormSnapshot<RouteSettings>> = {},
) {
  const worker = routeScope(roleValue, roleOverrides)
  const route: CrewRoute = { namespace: WORKER, nameKey: 'crewRoleWorker', scope: worker.scope }
  const catalog: RouteCatalogState = { value: CATALOG, status: 'ready' }
  render(
    <CrewRouteSection
      block={{
        routes: [route],
        catalog: createSnapshotStore<RouteCatalogState>(catalog),
        presets,
        loadCatalog: () => {},
      }}
      copy={COPY}
      t={t}
    />,
  )
  return worker
}

const picker = (): HTMLSelectElement => screen.getByLabelText<HTMLSelectElement>(COPY.presetLabel)

describe('the combination row', () => {
  it('treats a ready handle without a value as an empty list', () => {
    mount(FAST, presetScope([], { value: undefined }).scope)
    expect(picker().value).toBe('')
    expect(picker().options).toHaveLength(1)
  })

  it('shows the custom entry while the served routes match no combination', () => {
    mount(FAST, presetScope([]).scope)
    expect(picker().value).toBe('')
    expect(picker().options[0]!.textContent).toBe(COPY.presetCustom)
  })

  it('selects the combination the served routes match', () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }]
    mount(FAST, presetScope(stored).scope)
    expect(picker().value).toBe('a')
  })

  it('draws nothing while the Host serves no preset namespace', () => {
    mount(FAST, presetScope([], { status: 'unavailable' }).scope)
    expect(screen.queryByLabelText(COPY.presetLabel)).toBeNull()
  })

  it('writes the picked combination into the role route', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }]
    const worker = mount(FAST, presetScope(stored).scope)
    fireEvent.change(picker(), { target: { value: 'a' } })
    await waitFor(() => { expect(worker.mutate).toHaveBeenCalledOnce() })
    // The stored combination changes both the model and its effort.
    expect(worker.mutate.mock.calls[0]![0]).toEqual([
      { op: 'set', path: ['model'], value: 'alpha-pro' },
      { op: 'set', path: ['reasoningEffort'], value: 'low' },
    ])
    await screen.findByText(COPY.presetApplied)
  })

  it('puts the roles already switched back when a later one refuses', async () => {
    const stored: RoutePreset[] = [{
      id: 'a',
      name: 'Slow',
      routes: [{ namespace: WORKER, ...SLOW }, { namespace: 'subagent-planner-route-settings', ...SLOW }],
    }]
    const worker = routeScope(FAST)
    const refusing = routeScope(FAST, { writeFailure: 'refused' })
    refusing.mutate.mockResolvedValue(false)
    const routes: CrewRoute[] = [
      { namespace: WORKER, nameKey: 'crewRoleWorker', scope: worker.scope },
      { namespace: 'subagent-planner-route-settings', nameKey: 'crewRolePlanner', scope: refusing.scope },
    ]
    render(
      <CrewRouteSection
        block={{
          routes,
          catalog: createSnapshotStore<RouteCatalogState>({ value: CATALOG, status: 'ready' }),
          presets: presetScope(stored).scope,
          loadCatalog: () => {},
        }}
        copy={COPY}
        t={t}
      />,
    )
    fireEvent.change(picker(), { target: { value: 'a' } })
    await screen.findByText(COPY.presetRolledBack)
    // The worker moved forward, then was put back on the route it started from.
    expect(worker.mutate).toHaveBeenCalledTimes(2)
  })

  it('reports a locked role instead of writing anything', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }]
    const worker = mount(FAST, presetScope(stored).scope, { writeRefusal: 'a child is running' })
    fireEvent.change(picker(), { target: { value: 'a' } })
    await screen.findByText(COPY.presetLocked)
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('disables the picker while the document is read-only', () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }]
    mount(FAST, presetScope(stored, { writable: false }).scope)
    expect(picker().disabled).toBe(true)
  })

  it('reports a switch that the Host cannot start at all', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }]
    // A role whose value never landed cannot be switched, and the picker still
    // paints the stored choice.
    const worker = mount(FAST, presetScope(stored).scope, { status: 'loading', value: undefined })
    fireEvent.change(picker(), { target: { value: 'a' } })
    await screen.findByText(COPY.presetReadOnly)
    expect(worker.mutate).not.toHaveBeenCalled()
  })

  it('saves the served routes under a typed name', async () => {
    const scope = presetScope([])
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Fast' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(scope.mutate).toHaveBeenCalledOnce() })
    expect(scope.mutate.mock.calls[0]![0]).toEqual([{
      op: 'set',
      path: ['presets'],
      value: [{ id: 'preset-1', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }],
    }])
    await screen.findByText(COPY.presetSaved)
  })

  it('keeps the identity of the combination a save overwrites', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Old', routes: [{ namespace: WORKER, ...FAST }] }]
    const scope = presetScope(stored)
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(scope.mutate).toHaveBeenCalledOnce() })
    expect(scope.mutate.mock.calls[0]![0]).toEqual([{
      op: 'set',
      path: ['presets'],
      value: [{ id: 'a', name: 'Renamed', routes: [{ namespace: WORKER, ...FAST }] }],
    }])
  })

  it('writes once for a name-only change on an identical combination', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Old', routes: [{ namespace: WORKER, ...FAST }] }]
    const scope = presetScope(stored)
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Same' } })
    fireEvent.keyDown(screen.getByLabelText(COPY.presetName), { key: 'Enter' })
    await waitFor(() => { expect(scope.mutate).toHaveBeenCalledOnce() })
  })

  it('drops the naming field when the Enter key saves', async () => {
    const scope = presetScope([])
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    const field = screen.getByLabelText(COPY.presetName)
    fireEvent.change(field, { target: { value: 'Fast' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await screen.findByText(COPY.presetSaved)
    expect(screen.queryByLabelText(COPY.presetName)).toBeNull()
  })

  it('drops the naming field on the Escape key', () => {
    mount(FAST, presetScope([]).scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.keyDown(screen.getByLabelText(COPY.presetName), { key: 'Escape' })
    expect(screen.queryByLabelText(COPY.presetName)).toBeNull()
  })

  it('clears the notice when the picker returns to the custom entry', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }]
    mount(FAST, presetScope(stored).scope)
    fireEvent.change(picker(), { target: { value: 'a' } })
    await screen.findByText(COPY.presetApplied)
    fireEvent.change(picker(), { target: { value: '' } })
    await waitFor(() => { expect(screen.queryByText(COPY.presetApplied)).toBeNull() })
  })

  it('writes nothing when a save names the same combination as stored', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }]
    const scope = presetScope(stored)
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.keyDown(screen.getByLabelText(COPY.presetName), { key: 'Enter' })
    await waitFor(() => { expect(screen.queryByText(COPY.presetSaved)).toBeNull() })
    expect(scope.mutate).not.toHaveBeenCalled()
  })

  it('refuses a save without a name', () => {
    const scope = presetScope([])
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    expect(screen.getByRole('button', { name: COPY.presetConfirm }).hasAttribute('disabled')).toBe(true)
  })

  it('writes nothing when Enter confirms an empty name', () => {
    const scope = presetScope([])
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.keyDown(screen.getByLabelText(COPY.presetName), { key: 'Enter' })
    expect(scope.mutate).not.toHaveBeenCalled()
  })

  it('drops the naming field on cancel', () => {
    mount(FAST, presetScope([]).scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.click(screen.getByRole('button', { name: COPY.presetDismiss }))
    expect(screen.queryByLabelText(COPY.presetName)).toBeNull()
  })

  it('deletes the matching combination', async () => {
    const stored: RoutePreset[] = [
      { id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] },
      { id: 'b', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] },
    ]
    const scope = presetScope(stored)
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetDelete }))
    await waitFor(() => { expect(scope.mutate).toHaveBeenCalledOnce() })
    expect(scope.mutate.mock.calls[0]![0]).toEqual([{
      op: 'set',
      path: ['presets'],
      value: [{ id: 'b', name: 'Slow', routes: [{ namespace: WORKER, ...SLOW }] }],
    }])
    // Dropping an entry reports the drop, not the save that shares its write path.
    await screen.findByText(COPY.presetDeleted)
  })

  it('offers no delete action for an unsaved set', () => {
    mount(FAST, presetScope([]).scope)
    expect(screen.queryByRole('button', { name: COPY.presetDelete })).toBeNull()
  })

  it('reports a rejected combination write', async () => {
    const scope = failingPresetScope([], 'refused')
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetSave }))
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Fast' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await screen.findByText(COPY.presetRefused)
  })

  it('reports a stale combination write as a conflict', async () => {
    const stored: RoutePreset[] = [{ id: 'a', name: 'Fast', routes: [{ namespace: WORKER, ...FAST }] }]
    const scope = failingPresetScope(stored, 'conflict')
    mount(FAST, scope.scope)
    fireEvent.click(screen.getByRole('button', { name: COPY.presetDelete }))
    await screen.findByText(COPY.conflict)
  })
})
