// @vitest-environment jsdom
/**
 * The new-session crew combination picker: which combinations it offers, what
 * it stages, and that the stage reaches the session through the formation
 * Remote rather than through the role settings namespaces.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CrewChoice, type CrewChoiceProps } from '../src/client/CrewChoice.tsx'
import { CrewChoiceController, openingOf, routesOf, type CrewChoiceState } from '../src/client/crew-choice.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Copy lookup over the English dictionary; the component only names its own key. */
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

const WORKER = 'subagent-worker-route-settings'
const PLANNER = 'subagent-planner-route-settings'
const REVIEWER = 'subagent-reviewer-route-settings'

const ROUTES = [
  { namespace: WORKER, provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' },
  { namespace: PLANNER, provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' },
  { namespace: REVIEWER, provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' },
]

/** One combination library handle over a fixed value. */
function library(value: unknown, overrides: Partial<ConfigFormSnapshot<never>> = {}) {
  const snapshot = {
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
  } as never
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: () => Promise.resolve(true),
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  } as unknown as ConfigForm<never>
  return scope
}

/** A client context whose formation Remote answers with `selectRoutes`. */
function ctxWith(selectRoutes: (...args: unknown[]) => Promise<unknown>) {
  return { remote: { crewFormation: { selectRoutes } } } as never
}

describe('openingOf', () => {
  it('opens on the last used combination', () => {
    const value = { presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'b' }
    expect(openingOf(value)).toBe('b')
  })

  it('falls back to the first entry when the pointer names nothing stored', () => {
    expect(openingOf({ presets: [{ id: 'a', name: 'A', routes: ROUTES }], lastUsedPresetId: 'gone' })).toBe('a')
  })

  it('has nothing to open on an empty library', () => {
    expect(openingOf({ presets: [] })).toBeUndefined()
  })
})

describe('routesOf', () => {
  it('keys the three roles by name', () => {
    expect(routesOf({ id: 'a', name: 'A', routes: ROUTES })).toEqual({
      worker: { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' },
      planner: { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' },
      reviewer: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' },
    })
  })

  it('reports a combination that omits a role instead of inventing one', () => {
    expect(routesOf({ id: 'a', name: 'A', routes: ROUTES.slice(0, 2) })).toBeUndefined()
  })

  it('ignores a route whose namespace names no role', () => {
    const stray = { namespace: 'something-else', provider: 'x', model: 'y', reasoningEffort: 'z' }
    expect(routesOf({ id: 'a', name: 'A', routes: [...ROUTES, stray] })).toBeDefined()
  })
})

describe('CrewChoiceController', () => {
  it('loads the stored combinations and opens on the last used one', async () => {
    const controller = new CrewChoiceController(
      ctxWith(() => Promise.resolve({ ok: true, value: true })),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }], lastUsedPresetId: 'a' }),
    )
    await controller.load()
    expect(controller.store.getSnapshot().options).toEqual([{ id: 'a', name: 'A' }])
    expect(controller.store.getSnapshot().selected).toBe('a')
  })

  it('offers nothing when the Host serves no combination namespace', async () => {
    const controller = new CrewChoiceController(
      ctxWith(() => Promise.resolve({ ok: true, value: true })),
      undefined,
    )
    await controller.load()
    expect(controller.store.getSnapshot().options).toEqual([])
  })

  it('records the staged combination as the formation routes', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }))
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toBeUndefined()
    expect(selectRoutes).toHaveBeenCalledWith('session-1', {
      presetId: 'a',
      presetName: 'A',
      routes: {
        worker: { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' },
        planner: { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' },
        reviewer: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' },
      },
    })
    // Consumed: the next session opens on the library default again.
    expect(controller.stage()).toBeUndefined()
  })

  it('does nothing when no combination is staged', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [] }))
    await controller.load()
    expect(await controller.applyToSession('session-1' as never)).toBeUndefined()
    expect(selectRoutes).not.toHaveBeenCalled()
  })

  it('surfaces a Host refusal and keeps the stage for a retry', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: false, error: { message: 'unknown model' } }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }))
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toBe('unknown model')
    expect(controller.store.getSnapshot().error).toBe('unknown model')
    // The stage survives so a corrected pick does not silently fall back to
    // whatever the library default is.
    expect(controller.stage()).toBe('a')
  })

  it('refuses a combination that vanished between staging and applying', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }))
    await controller.load()
    controller.select('a')
    // The Host answered an empty library after the pick was staged.
    const dropped = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [] }))
    await dropped.load()
    dropped.select('a')
    expect(await dropped.applyToSession('session-1' as never)).toContain('no longer stored')
    expect(selectRoutes).not.toHaveBeenCalled()
  })

  it('refuses a combination that does not name all three roles', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const partial = [{ namespace: WORKER, provider: 'a', model: 'b', reasoningEffort: 'c' }]
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: partial }] }))
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toContain('all three roles')
    expect(selectRoutes).not.toHaveBeenCalled()
  })
})

describe('CrewChoice', () => {
  /** Mount the picker over one staged preset and one library. */
  function mount(presetId: string, options: { id: string; name: string }[]) {
    const seat: AgentPresetSeatState = {
      options: [], current: presetId, error: null, busy: false, introduce: false,
    }
    // The picker's own state, built here rather than by the controller: this
    // mount exercises rendering, and the controller has its own cases above.
    const choice = createSnapshotStore<CrewChoiceState>({
      options: options.map(option => ({ ...option })),
      selected: options[0]?.id ?? '',
      error: null,
    })
    const select = vi.fn()
    render(
      <CrewChoice {...({
        useCrewChoice: (selector: (state: CrewChoiceState) => unknown) => selector(choice.getSnapshot()),
        useAgentPresetSeat: (selector: (state: AgentPresetSeatState) => unknown) => selector(seat),
        load: () => Promise.resolve(),
        select,
        t,
      } as unknown as CrewChoiceProps)} />,
    )
    return { select }
  }

  it('draws nothing while another preset is staged', () => {
    mount('standard', [{ id: 'a', name: 'Fast' }])
    expect(screen.queryByLabelText(t('crewChoiceLabel'))).toBeNull()
  })

  it('draws nothing while the deployment stores no combination', () => {
    mount('crew', [])
    expect(screen.queryByLabelText(t('crewChoiceLabel'))).toBeNull()
  })

  it('offers every stored combination while crew is staged', () => {
    mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    const picker = screen.getByLabelText<HTMLSelectElement>(t('crewChoiceLabel'))
    expect([...picker.options].map(option => option.textContent)).toEqual(['Fast', 'Deep'])
  })

  it('stages the picked combination', () => {
    const { select } = mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    fireEvent.change(screen.getByLabelText(t('crewChoiceLabel')), { target: { value: 'b' } })
    expect(select).toHaveBeenCalledWith('b')
  })
})
