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

/** Whether one form control is disabled. */
const disabled = (element: HTMLElement): boolean => (element as HTMLInputElement).disabled

/** The option values of the select carrying one label. */
const optionValues = (label: string): string[] =>
  [...screen.getByLabelText<HTMLSelectElement>(label).options].map(option => option.value)

/** The control a role label carries once the role name replaces its placeholder. */
const roleLabel = (template: string, role = en.crewRoleWorker): string =>
  template.replaceAll('{role}', role)

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
    expect(effortFor(CATALOG.groups[1]!.models[0], 'max')).toBe('max')
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
  it('draws one block and loads the catalog once', () => {
    const { loadCatalog } = mount([
      roleOverride('crewRoleWorker'),
      roleOverride('crewRolePlanner', { value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' } }),
      roleOverride('crewRoleReviewer'),
    ])
    expect(screen.getAllByText(COPY.title)).toHaveLength(1)
    expect(loadCatalog).toHaveBeenCalledTimes(1)
  })

  it('draws nothing when the Host serves no role namespace', () => {
    mount([])
    expect(screen.queryByText(COPY.title)).toBeNull()
  })

  it('names the role picker after each role, so every role stays addressable', () => {
    mount([roleOverride('crewRoleWorker'), roleOverride('crewRolePlanner'), roleOverride('crewRoleReviewer')])
    const picker = screen.getByLabelText<HTMLSelectElement>(COPY.presetRole)
    expect([...picker.options].map(option => option.textContent))
      .toEqual([t('crewRoleWorker'), t('crewRolePlanner'), t('crewRoleReviewer')])
  })

  it('edits the selected role without writing any role namespace', () => {
    const { roles } = mount([
      roleOverride('crewRoleWorker'),
      roleOverride('crewRolePlanner', { value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' } }),
    ])
    // The editor's pickers carry the plain role labels: one role at a time is
    // edited, so the role name is the picker's own value rather than each
    // control's prefix.
    expect(optionValues(roleLabel(COPY.provider))).toEqual(['alpha', 'beta'])
    fireEvent.change(screen.getByLabelText(roleLabel(COPY.model)), { target: { value: 'alpha-pro' } })
    for (const role of roles) expect(role.mutate).not.toHaveBeenCalled()
  })

  it('follows the catalog when a provider changes: the model list and effort both move', () => {
    mount([roleOverride('crewRoleWorker')])
    expect(optionValues(roleLabel(COPY.model))).toEqual(['alpha-fast', 'alpha-pro'])
    fireEvent.change(screen.getByLabelText(roleLabel(COPY.provider)), { target: { value: 'beta' } })
    // Beta advertises one model and no reasoning dimension, so the model list
    // narrows and the effort falls back to a text field.
    expect(optionValues(roleLabel(COPY.model))).toEqual(['beta-plain'])
    expect(screen.getByLabelText(roleLabel(COPY.effort))).toBeTruthy()
  })

  it('keeps a stored route the catalog does not advertise', () => {
    mount([roleOverride('crewRoleWorker', {
      value: { provider: 'ghost', model: 'ghost-model', reasoningEffort: 'high' },
    })])
    expect(optionValues(roleLabel(COPY.provider))).toEqual(['ghost', 'alpha', 'beta'])
    // The ghost model advertises no reasoning levels, so the effort stays a text
    // field carrying the stored value rather than a list that cannot name it.
    expect(screen.getByLabelText<HTMLInputElement>(roleLabel(COPY.effort)).value).toBe('high')
  })

  it('falls back to the effort text field when the model advertises no levels', () => {
    mount([roleOverride('crewRoleWorker', {
      value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'custom-35' },
    })])
    const effort = screen.getByLabelText<HTMLInputElement>(roleLabel(COPY.effort))
    expect(effort.tagName).toBe('INPUT')
    expect(effort.value).toBe('custom-35')
  })

  it('disables the editor while the combination list is read-only', () => {
    mount(
      [roleOverride('crewRoleWorker')],
      CATALOG,
      presetsWith({ writable: false }).scope,
    )
    expect(disabled(screen.getByLabelText(COPY.presetLabel))).toBe(true)
    expect(disabled(screen.getByLabelText(roleLabel(COPY.model)))).toBe(true)
  })

  it('reports a refused combination write instead of reverting silently', async () => {
    const handle = presetsWith()
    handle.scope.mutate = vi.fn(async () => {
      // The controller publishes the failure after the rejected write settles.
      Object.assign(handle.scope.getSnapshot(), { writeFailure: 'refused' as const })
      return false
    })
    mount([roleOverride('crewRoleWorker')], CATALOG, handle.scope)
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Fast' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(screen.getByText(COPY.presetRefused)).toBeTruthy() })
  })

  it('reports a stale page as a reload rather than a refusal', async () => {
    const handle = presetsWith()
    handle.scope.mutate = vi.fn(async () => {
      Object.assign(handle.scope.getSnapshot(), { writeFailure: 'conflict' as const })
      return false
    })
    mount([roleOverride('crewRoleWorker')], CATALOG, handle.scope)
    fireEvent.change(screen.getByLabelText(COPY.presetName), { target: { value: 'Fast' } })
    fireEvent.click(screen.getByRole('button', { name: COPY.presetConfirm }))
    await waitFor(() => { expect(screen.getByText(COPY.conflict)).toBeTruthy() })
  })
})
