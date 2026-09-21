// @vitest-environment jsdom
/** The Models page's worker-route block: catalog-driven pickers over the Host route setting. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { WorkerRouteSection } from '../src/client/WorkerRouteSection.tsx'
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
function scopeWith(overrides: Partial<SettingsScopeSnapshot<WorkerRouteSettings>> = {}) {
  const snapshot: SettingsScopeSnapshot<WorkerRouteSettings> = {
    status: 'ready',
    value: ROUTE,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  }
  const set = vi.fn(() => Promise.resolve())
  const scope: SettingsScope<WorkerRouteSettings> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: () => Promise.resolve(),
    set,
    unset: () => Promise.resolve(),
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

function mount(overrides: Partial<SettingsScopeSnapshot<WorkerRouteSettings>> = {}, catalog: ModelCatalog | null = CATALOG) {
  const { scope, set } = scopeWith(overrides)
  const store = catalogWith(catalog)
  const loadCatalog = vi.fn()
  render(<WorkerRouteSection scope={scope} catalog={store} loadCatalog={loadCatalog} t={t} />)
  return { set, loadCatalog, store }
}

describe('WorkerRouteSection', () => {
  it('shows the stored route and loads the catalog once', () => {
    const { loadCatalog } = mount()

    expect(loadCatalog).toHaveBeenCalledTimes(1)
    expect(value(screen.getByLabelText(en.workerRouteProvider))).toBe('alpha')
    expect(value(screen.getByLabelText(en.workerRouteModel))).toBe('alpha-fast')
    expect(value(screen.getByLabelText(en.workerRouteEffort))).toBe('high')
  })

  it('writes each picked field through the settings scope', () => {
    const { set } = mount()

    fireEvent.change(screen.getByLabelText(en.workerRouteProvider), { target: { value: 'beta' } })
    expect(set).toHaveBeenCalledWith('provider', 'beta')

    fireEvent.change(screen.getByLabelText(en.workerRouteEffort), { target: { value: 'low' } })
    expect(set).toHaveBeenCalledWith('reasoningEffort', 'low')
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
})
