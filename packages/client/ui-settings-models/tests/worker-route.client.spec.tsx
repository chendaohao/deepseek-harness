// @vitest-environment jsdom
/** The Models page's worker-route block: catalog-driven pickers over the Host route setting. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { WorkerRouteSection } from '../src/client/WorkerRouteSection.tsx'
import { WorkerRouteCatalog } from '../src/client/worker-route.ts'
import type { WorkerRouteCatalogState, WorkerRouteSettings } from '../src/client/worker-route.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** The current value of one form control. */
const value = (element: HTMLElement): string => (element as HTMLInputElement).value

/** Whether one form control is disabled. */
const disabled = (element: HTMLElement): boolean => (element as HTMLInputElement).disabled

/** The option values of the select carrying one label. */
const optionValues = (label: string): string[] =>
  [...screen.getByLabelText<HTMLSelectElement>(label).options].map(option => option.value)

const ROUTE: WorkerRouteSettings = {
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
      ],
    },
    // A provider whose model advertises no reasoning dimension at all.
    { id: 'beta', name: 'Beta', models: [{ id: 'beta-plain', name: 'Beta Plain' }] },
  ],
  failures: [],
}

/** Build a scope over one mutable snapshot, recording every write. */
function scopeWith(overrides: Partial<ConfigFormSnapshot<WorkerRouteSettings>> = {}) {
  const snapshot: ConfigFormSnapshot<WorkerRouteSettings> = {
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
  const set = vi.fn(() => Promise.resolve(true))
  const scope: ConfigForm<WorkerRouteSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
    set,
    unset: () => Promise.resolve(true),
  }
  return { scope, set }
}

/** Build the catalog store the block reads its pickers from. */
function catalogWith(value: ModelCatalog | null) {
  return createSnapshotStore<WorkerRouteCatalogState>({
    value,
    status: value === null ? 'loading' : 'ready',
  })
}

function mount(
  overrides: Partial<ConfigFormSnapshot<WorkerRouteSettings>> = {},
  catalog: ModelCatalog | null = CATALOG,
) {
  const { scope, set } = scopeWith(overrides)
  const store = catalogWith(catalog)
  const loadCatalog = vi.fn()
  render(
    <WorkerRouteSection scope={scope} catalog={store} loadCatalog={loadCatalog} t={t} />,
  )
  return { set, loadCatalog, store }
}

describe('WorkerRouteCatalog', () => {
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
    const catalog = new WorkerRouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    catalog.load()
    expect(catalog.store.getSnapshot().status).toBe('loading')
    expect(modelCatalog).toHaveBeenCalledTimes(1)

    resolveRead({ ok: true, value: CATALOG_VALUE })
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    expect(catalog.store.getSnapshot().value).toEqual(CATALOG_VALUE)
  })

  it('keeps the load idempotent once a catalog is held', async () => {
    const modelCatalog = vi.fn(() => Promise.resolve({ ok: true, value: CATALOG_VALUE }))
    const catalog = new WorkerRouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    catalog.load()

    expect(modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('reports a refused catalog read without publishing a value', async () => {
    const catalog = new WorkerRouteCatalog(catalogCtx(
      () => Promise.resolve({ ok: false, error: { message: 'catalog down' } }),
    ))

    catalog.load()
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('error') })
    expect(catalog.store.getSnapshot().value).toBeNull()
  })

  it('reports a rejected catalog read without publishing a value', async () => {
    const catalog = new WorkerRouteCatalog(catalogCtx(() => Promise.reject(new Error('carrier down'))))

    catalog.load()
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('error') })
    expect(catalog.store.getSnapshot().value).toBeNull()
  })

  it('refetches after a reset, which is what a reconnected client needs', async () => {
    const modelCatalog = vi.fn(() => Promise.resolve({ ok: true, value: CATALOG_VALUE }))
    const catalog = new WorkerRouteCatalog(catalogCtx(modelCatalog))

    catalog.load()
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    catalog.reset()
    expect(catalog.store.getSnapshot()).toEqual({ value: null, status: 'idle' })

    catalog.load()
    await vi.waitFor(() => { expect(catalog.store.getSnapshot().status).toBe('ready') })
    expect(modelCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('WorkerRouteSection', () => {
  it('shows the stored route and loads the catalog once', () => {
    const { loadCatalog } = mount()

    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(value(screen.getByLabelText(en.workerRouteProvider))).toBe('alpha')
    expect(value(screen.getByLabelText(en.workerRouteModel))).toBe('alpha-fast')
    expect(value(screen.getByLabelText(en.workerRouteEffort))).toBe('high')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('writes each picked field through the settings scope', () => {
    const { set } = mount()

    fireEvent.change(screen.getByLabelText(en.workerRouteProvider), { target: { value: 'beta' } })
    expect(set).toHaveBeenCalledWith('provider', 'beta')

    fireEvent.change(screen.getByLabelText(en.workerRouteModel), { target: { value: 'alpha-fast' } })
    expect(set).toHaveBeenCalledWith('model', 'alpha-fast')

    fireEvent.change(screen.getByLabelText(en.workerRouteEffort), { target: { value: 'low' } })
    expect(set).toHaveBeenCalledWith('reasoningEffort', 'low')
  })

  it('writes a typed effort through the fallback text field', () => {
    const { set } = mount({ value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'high' } })

    fireEvent.change(screen.getByLabelText(en.workerRouteEffort), { target: { value: 'medium' } })
    expect(set).toHaveBeenCalledWith('reasoningEffort', 'medium')
  })

  it('offers only the efforts the selected model advertises', () => {
    mount()

    expect(optionValues(en.workerRouteEffort)).toEqual(['low', 'high'])
  })

  it('keeps the stored effort selectable when the model does not advertise it', () => {
    mount({ value: { ...ROUTE, reasoningEffort: 'max' } })

    expect(optionValues(en.workerRouteEffort)).toEqual(['max', 'low', 'high'])
  })

  it('falls back to a text field when the model advertises no efforts', () => {
    mount({ value: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'high' } })
    const effort = screen.getByLabelText(en.workerRouteEffort)

    expect(effort.tagName).toBe('INPUT')
    expect(value(effort)).toBe('high')
  })

  it('keeps a stored route selectable when the catalog no longer advertises it', () => {
    mount({ value: { provider: 'gamma', model: 'gamma-only', reasoningEffort: 'high' } }, null)

    expect(value(screen.getByLabelText(en.workerRouteProvider))).toBe('gamma')
    expect(value(screen.getByLabelText(en.workerRouteModel))).toBe('gamma-only')
  })

  it('renders the block with empty controls while the first section has not landed', () => {
    const { scope } = scopeWith({ status: 'loading', value: undefined })
    const store = catalogWith(CATALOG)
    const { container } = render(
      <WorkerRouteSection scope={scope} catalog={store} loadCatalog={() => {}} t={t} />,
    )

    // `loading` is not `unavailable`: the section renders and every control is
    // disabled until a value arrives, so the layout does not jump in later.
    expect(container.childElementCount).toBe(1)
    expect(screen.getByLabelText(en.workerRouteProvider).tagName).toBe('SELECT')
    expect(disabled(screen.getByLabelText(en.workerRouteProvider))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteModel))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteEffort))).toBe(true)
  })

  it('drops the effort picker to the fallback field when a stored provider is not in the catalog', () => {
    mount({ value: { provider: 'gamma', model: 'gamma-only', reasoningEffort: 'high' } }, CATALOG)

    // No group means no advertised efforts, so the stored id stays editable.
    expect(screen.getByLabelText(en.workerRouteEffort).tagName).toBe('INPUT')
  })

  it('renders nothing while the Host does not expose the namespace', () => {
    const { scope } = scopeWith({ status: 'unavailable', value: undefined })
    const store = catalogWith(null)
    const { container } = render(
      <WorkerRouteSection scope={scope} catalog={store} loadCatalog={() => {}} t={t} />,
    )

    expect(container.childElementCount).toBe(0)
  })

  it('disables every control when the document is read-only', () => {
    mount({ writable: false })

    expect(disabled(screen.getByLabelText(en.workerRouteProvider))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteModel))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteEffort))).toBe(true)
  })

  it('disables the controls from the Host-published refusal, not a client-side guess', () => {
    mount({ writeRefusal: 'worker "w-1" is running' })

    expect(disabled(screen.getByLabelText(en.workerRouteProvider))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteModel))).toBe(true)
    expect(disabled(screen.getByLabelText(en.workerRouteEffort))).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(en.workerRouteLocked)
  })

  it('reports a refused write instead of reverting silently', () => {
    mount({ writeFailure: 'refused' })

    expect(screen.getByRole('alert').textContent).toBe(en.workerRouteRefused)
    expect(disabled(screen.getByLabelText(en.workerRouteProvider))).toBe(false)
  })

  it('reports a stale-revision write as a reload rather than a refusal', () => {
    mount({ writeFailure: 'conflict' })

    expect(screen.getByRole('alert').textContent).toBe(en.workerRouteConflict)
  })

  it('shows no failure notice before any write is rejected', () => {
    mount()

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
