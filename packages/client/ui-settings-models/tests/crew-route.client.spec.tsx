// @vitest-environment jsdom
/** The Models page's crew-route block: catalog-driven pickers over each role's Host route setting. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CrewRouteSection, effortFor, modelForProvider, roleCopy, type CrewRouteCopy } from '../src/client/CrewRouteSection.tsx'
import { CREW_ROLES, type CrewRoute } from '../src/client/crew-routes.ts'
import { servedCrewRoutes } from '../src/client/ModelsSection.tsx'
import { RouteCatalog } from '../src/client/route-settings.ts'
import type { RoutePresetsSettings } from '../src/client/crew-presets.ts'
import type { RouteCatalogState, RouteSettings } from '../src/client/route-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** The page's `t` seat: the English dictionary plus `{name}` interpolation. */
const t = (key: keyof typeof en, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
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

/** The current value of one form control. */
const value = (element: HTMLElement): string => (element as HTMLInputElement).value

/** Whether one form control is disabled. */
const disabled = (element: HTMLElement): boolean => (element as HTMLInputElement).disabled

/** The option values of the select carrying one label. */
const optionValues = (label: string): string[] =>
  [...screen.getByLabelText<HTMLSelectElement>(label).options].map(option => option.value)

const ROUTE: RouteSettings = {
  provider: 'alpha',
  model: 'alpha-fast',
  reasoningEffort: 'high',
}

/** A catalog advertising two providers with differing effort vocabularies. */
const CATALOG: ModelCatalog = {
  default: { provider: 'alpha', model: 'alpha-fast' },
  routableProviders: ['alpha', 'beta'],
  groups: [
    {
      id: 'alpha',
      name: 'Alpha',
      models: [
        {
          id: 'alpha-fast',
          name: 'Alpha Fast',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
        { id: 'alpha-pro', name: 'Alpha Pro' },
      ],
    },
    // A provider whose model advertises no reasoning dimension at all.
    { id: 'beta', name: 'Beta', models: [{ id: 'beta-plain', name: 'Beta Plain' }] },
  ],
  failures: [],
}

/** Build a scope over one mutable snapshot, recording every queued mutation. */
function scopeWith(overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<RouteSettings> = {
    status: 'ready',
    value: ROUTE,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    writeRefusal: undefined,
    writeFailure: undefined,
    mode: 'host',
    ...overrides,
  }
  const mutate = vi.fn(() => Promise.resolve(true))
  const scope: ConfigForm<RouteSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { scope, mutate }
}

/** Build the catalog store the block reads its pickers from. */
function catalogWith(value: ModelCatalog | null) {
  return createSnapshotStore<RouteCatalogState>({
    value,
    status: value === null ? 'loading' : 'ready',
  })
}

/** One role handle over a scripted scope. */
function roleOverride(
  nameKey: CrewRoute['nameKey'],
  overrides: Partial<ConfigFormSnapshot<RouteSettings>> = {},
) {
  const { scope, mutate } = scopeWith(overrides)
  return { scope, mutate, route: { namespace: `ns-${nameKey}`, nameKey, scope } }
}

/**
 * Mount the block over one scripted role per entry of `roles`.
 * @param roles - the roles to render, each with its own scope.
 * @param catalog - the catalog value the pickers read, or null while loading.
 * @returns every role's mutation spy and the catalog loader.
 */
/** Build a preset handle over one mutable list, recording every queued write. */
function presetsWith(overrides: Partial<ConfigFormSnapshot<RoutePresetsSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<RoutePresetsSettings> = {
    status: 'ready',
    value: { presets: [] },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    writeRefusal: undefined,
    writeFailure: undefined,
    mode: 'host',
    ...overrides,
  }
  const mutate = vi.fn(() => Promise.resolve(true))
  const scope: ConfigForm<RoutePresetsSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate,
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  }
  return { scope, mutate }
}

function mount(
  roles: readonly ReturnType<typeof roleOverride>[] = [roleOverride('crewRoleWorker')],
  catalog: ModelCatalog | null = CATALOG,
  presets: ConfigForm<RoutePresetsSettings> = presetsWith().scope,
) {
  const store = catalogWith(catalog)
  const loadCatalog = vi.fn()
  const block = { routes: roles.map(role => role.route), catalog: store, presets, loadCatalog }
  const view = render(<CrewRouteSection block={block} copy={COPY} t={t} />)
  return { roles, loadCatalog, store, view }
}

/** The label one role's control carries. */
const labelFor = (role: string, control: string): string =>
  roleCopy(control, role)

describe('roleCopy', () => {
  it('replaces every placeholder with the role name', () => {
    expect(roleCopy('{role} provider — {role}', 'Worker')).toBe('Worker provider — Worker')
  })

  it('leaves a template without the placeholder alone', () => {
    expect(roleCopy('Stored route', 'Worker')).toBe('Stored route')
  })
})

describe('effortFor', () => {
  const MODEL = CATALOG.groups[0]!.models[0]!

  it('keeps a stored effort the model advertises', () => {
    expect(effortFor(MODEL, 'low')).toBe('low')
  })

  it('falls back to the model default when the stored effort is gone', () => {
    expect(effortFor(MODEL, 'max')).toBe('high')
  })

  it('falls back to the first advertised effort without a declared default', () => {
    expect(effortFor({ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'x', name: 'X' }] } }, 'max')).toBe('x')
  })

  it('keeps the stored effort when the model advertises none or is unknown', () => {
    expect(effortFor(CATALOG.groups[1]!.models[0]!, 'max')).toBe('max')
    expect(effortFor(undefined, 'max')).toBe('max')
  })
})

describe('modelForProvider', () => {
  it('keeps a stored model the new provider also advertises', () => {
    expect(modelForProvider(CATALOG.groups, 'alpha', 'alpha-pro')).toBe('alpha-pro')
  })

  it('picks the new provider first model when the stored one belongs to another', () => {
    expect(modelForProvider(CATALOG.groups, 'beta', 'alpha-fast')).toBe('beta-plain')
  })

  it('keeps the stored model when the catalog does not advertise the provider', () => {
    expect(modelForProvider(CATALOG.groups, 'gamma', 'gamma-only')).toBe('gamma-only')
  })

  it('keeps the stored model when the advertised provider has no models', () => {
    expect(modelForProvider([{ id: 'gamma', name: 'Gamma', models: [] }], 'gamma', 'kept')).toBe('kept')
  })
})

describe('CrewRouteCatalog', () => {
  /** A context whose session remote answers the catalog read with `answer`. */
  function catalogCtx(answer: () => Promise<unknown>) {
    // The constructor takes the client Context; only the one remote member the
    // catalog reads is scripted here.
    return { remote: { session: { modelCatalog: answer } } } as never
  }

  const CATALOG_VALUE = { default: { provider: 'alpha', model: 'm' }, routableProviders: [], groups: [], failures: [] }

  it('publishes the answered catalog and shares one in-flight read', async () => {
    let resolveRead: (value: unknown) => void = () => {}
    const read = new Promise((resolve) => { resolveRead = resolve })
    const modelCatalog = vi.fn(() => read)
    const catalog = new RouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    catalog.load()
    expect(catalog.store.getSnapshot().status).toBe('loading')
    expect(modelCatalog).toHaveBeenCalledTimes(1)

    resolveRead({ ok: true, value: CATALOG_VALUE })
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    expect(catalog.store.getSnapshot().value).toEqual(CATALOG_VALUE)
  })

  it('keeps the load idempotent once a catalog is held', async () => {
    const modelCatalog = vi.fn(() => Promise.resolve({ ok: true, value: CATALOG_VALUE }))
    const catalog = new RouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    catalog.load()

    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('reports a refused catalog read without publishing a value', async () => {
    const catalog = new RouteCatalog(catalogCtx(
      () => Promise.resolve({ ok: false, error: { message: 'catalog down' } }),
    ))

    catalog.load()
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('error') })
    expect(catalog.store.getSnapshot().value).toBeNull()
  })

  it('reports a rejected catalog read without publishing a value', async () => {
    const catalog = new RouteCatalog(catalogCtx(() => Promise.reject(new Error('carrier down'))))

    catalog.load()
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('error') })
    expect(catalog.store.getSnapshot().value).toBeNull()
  })

  it('refetches after a reset, which is what a reconnected client needs', async () => {
    const modelCatalog = vi.fn(() => Promise.resolve({ ok: true, value: CATALOG_VALUE }))
    const catalog = new RouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    catalog.reset()
    expect(catalog.store.getSnapshot()).toEqual({ value: null, status: 'idle' })

    catalog.load()
    await waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('servedCrewRoutes', () => {
  const ROUTES = CREW_ROLES.map(role => ({ namespace: role.namespace, nameKey: role.nameKey, scope: scopeWith().scope }))

  it('keeps only the roles whose namespace the Host serves, in table order', () => {
    const served = new Map([['subagent-reviewer-route-settings', {}], ['subagent-worker-route-settings', {}]])
    expect(servedCrewRoutes(ROUTES, served).map(route => route.namespace))
      .toEqual(['subagent-worker-route-settings', 'subagent-reviewer-route-settings'])
  })

  it('returns nothing when the Host serves no role namespace', () => {
    expect(servedCrewRoutes(ROUTES, new Map())).toEqual([])
  })
})

describe('CrewRouteSection', () => {
  it('shows every role in one block with the stored routes and loads the catalog once', () => {
    const { loadCatalog } = mount([
      roleOverride('crewRoleWorker'),
      roleOverride('crewRolePlanner', { value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' } }),
    ])

    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(en.crewRouteTitle)
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(value(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe('alpha')
    expect(value(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)))).toBe('alpha-fast')
    expect(value(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)))).toBe('high')
    expect(value(screen.getByLabelText(labelFor('Planner', en.crewRouteProvider)))).toBe('beta')
  })

  it('names each role control after its role, so three pickers stay distinguishable', () => {
    mount([
      roleOverride('crewRoleWorker'),
      roleOverride('crewRolePlanner'),
      roleOverride('crewRoleReviewer'),
    ])

    for (const role of ['Worker', 'Planner', 'Reviewer']) {
      expect(screen.getByLabelText(labelFor(role, en.crewRouteProvider))).toBeDefined()
    }
  })

  it('writes the one picked field when the catalog cannot improve on it', () => {
    const { roles } = mount()
    const mutate = roles[0]!.mutate

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)), { target: { value: 'alpha-pro' } })
    // Alpha Pro advertises no efforts, so the stored effort stays editable.
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['model'], value: 'alpha-pro' },
    ])
  })

  it('resets the effort when the new model advertises a different vocabulary', () => {
    // Alpha Pro advertises no efforts, so \`max\` was storable there; Alpha Fast
    // advertises low and high, and its default replaces the stranded value.
    const { roles } = mount([
      roleOverride('crewRoleWorker', { value: { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'max' } }),
    ])
    const mutate = roles[0]!.mutate

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)), { target: { value: 'alpha-fast' } })
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['model'], value: 'alpha-fast' },
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
    ])
  })

  it('carries provider, model, and effort in one mutation when the provider changes', () => {
    const { roles } = mount()
    const mutate = roles[0]!.mutate

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)), { target: { value: 'beta' } })
    // Beta's only model advertises no efforts, so the stored effort survives and
    // only the stranded model is carried along.
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['provider'], value: 'beta' },
      { op: 'set', path: ['model'], value: 'beta-plain' },
    ])
  })

  it('keeps a stored route the catalog does not advertise instead of rewriting it', () => {
    const { roles } = mount([
      roleOverride('crewRoleWorker', { value: { provider: 'gamma', model: 'gamma-only', reasoningEffort: 'high' } }),
    ], null)
    const mutate = roles[0]!.mutate

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)), { target: { value: 'medium' } })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['reasoningEffort'], value: 'medium' }])
  })

  it('announces a route the edit reset', async () => {
    mount([
      roleOverride('crewRoleWorker', { value: { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'high' } }),
    ])

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)), { target: { value: 'alpha-fast' } })
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en.crewRouteReset) })
  })

  it('does not announce a reset when the pick changes nothing', async () => {
    const { roles } = mount()
    const mutate = roles[0]!.mutate

    // Re-picking the provider already stored strands no field, so the row
    // writes nothing at all rather than a no-op mutation.
    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)), { target: { value: 'alpha' } })
    await Promise.resolve()
    expect(mutate).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers only the efforts the selected model advertises', () => {
    mount()

    expect(optionValues(labelFor('Worker', en.crewRouteEffort))).toEqual(['low', 'high'])
  })

  it('keeps the stored effort selectable when the model does not advertise it', () => {
    mount([roleOverride('crewRoleWorker', { value: { ...ROUTE, reasoningEffort: 'max' } })])

    expect(optionValues(labelFor('Worker', en.crewRouteEffort))).toEqual(['max', 'low', 'high'])
  })

  it('falls back to a text field when the model advertises no efforts', () => {
    mount([roleOverride('crewRoleWorker', { value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'high' } })])
    const effort = screen.getByLabelText(labelFor('Worker', en.crewRouteEffort))

    expect(effort.tagName).toBe('INPUT')
    expect(value(effort)).toBe('high')
  })

  it('keeps a stored route selectable when the catalog no longer advertises it', () => {
    mount(
      [roleOverride('crewRoleWorker', { value: { provider: 'gamma', model: 'gamma-only', reasoningEffort: 'high' } })],
      null,
    )

    expect(value(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe('gamma')
    expect(value(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)))).toBe('gamma-only')
  })

  it('renders a role with empty controls while the first section has not landed', () => {
    mount([roleOverride('crewRoleWorker', { status: 'loading', value: undefined })])

    // `loading` is not `unavailable`: the row renders and every control is
    // disabled until a value arrives, so the layout does not jump in later.
    expect(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)).tagName).toBe('SELECT')
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)))).toBe(true)
  })

  it('drops the effort picker to the fallback field when a stored provider is not in the catalog', () => {
    mount([roleOverride('crewRoleWorker', { value: { provider: 'gamma', model: 'gamma-only', reasoningEffort: 'high' } })])

    // No group means no advertised efforts, so the stored id stays editable.
    expect(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)).tagName).toBe('INPUT')
  })

  it('draws no row while the Host does not serve that namespace', () => {
    mount([
      roleOverride('crewRoleWorker', { status: 'unavailable', value: undefined }),
      roleOverride('crewRolePlanner'),
    ])

    expect(screen.getAllByRole('group')).toHaveLength(1)
    expect(screen.queryByLabelText(labelFor('Worker', en.crewRouteProvider))).toBeNull()
    expect(screen.getByLabelText(labelFor('Planner', en.crewRouteProvider))).toBeDefined()
  })

  it('draws nothing at all when the Host serves none of the namespaces', () => {
    const { view } = mount([])

    // Without the crew bundle no role namespace is served, so the block leaves
    // not even a heading behind.
    expect(view.container.innerHTML).toBe('')
  })

  it('disables every control when the document is read-only', () => {
    mount([roleOverride('crewRoleWorker', { writable: false })])

    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)))).toBe(true)
  })

  it('disables the controls from the Host-published refusal, not a client-side guess', () => {
    mount([roleOverride('crewRoleWorker', { writeRefusal: 'worker "w-1" is running' })])

    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteModel)))).toBe(true)
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)))).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(labelFor('Worker', en.crewRouteLocked))
  })

  it('reports a refused write instead of reverting silently', () => {
    mount([roleOverride('crewRoleWorker', { writeFailure: 'refused' })])

    expect(screen.getByRole('alert').textContent).toBe(labelFor('Worker', en.crewRouteRefused))
    expect(disabled(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)))).toBe(false)
  })

  it('reports a stale-revision write as a reload rather than a refusal', () => {
    mount([roleOverride('crewRoleWorker', { writeFailure: 'conflict' })])

    expect(screen.getByRole('alert').textContent).toBe(en.crewRouteConflict)
  })

  it('writes an effort picked from the advertised levels', () => {
    const { roles } = mount()
    const mutate = roles[0]!.mutate

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteEffort)), { target: { value: 'low' } })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['reasoningEffort'], value: 'low' }])
  })

  it('announces nothing when the Host refuses the cascaded write', async () => {
    const roles = [roleOverride('crewRoleWorker')]
    roles[0]!.mutate.mockResolvedValue(false)
    mount(roles)

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)), { target: { value: 'beta' } })
    await waitFor(() => { expect(roles[0]!.mutate).toHaveBeenCalled() })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ignores a pick while no value has landed yet', () => {
    // The controls are disabled in that state, so this is the guard behind them.
    const roles = [roleOverride('crewRoleWorker', { status: 'loading', value: undefined })]
    mount(roles)

    fireEvent.change(screen.getByLabelText(labelFor('Worker', en.crewRouteProvider)), { target: { value: 'beta' } })
    expect(roles[0]!.mutate).not.toHaveBeenCalled()
  })

  it('shows no failure notice before any write is rejected', () => {
    mount()

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
