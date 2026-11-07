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
const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}

/** The reporter every controller in this spec is built with. */
const report = (failure: { reason: string; message?: string }): string => {
  switch (failure.reason) {
    case 'gone': return t('crewChoiceGone')
    case 'incomplete': return t('crewChoiceIncomplete')
    case 'unserved': return t('crewChoiceUnserved')
    default: return t('crewChoiceRefused', { reason: failure.message ?? '' })
  }
}

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

/**
 * A client context whose formation Remote answers with `selectRoutes`.
 *
 * `ctx.get` is the read path the controller uses, because the crew bundle is an
 * optional deployment: injecting the namespace would park this plugin forever on
 * a deployment that serves no formation.
 */
function ctxWith(selectRoutes: ((...args: unknown[]) => Promise<unknown>) | undefined) {
  return {
    get: (name: string) => (name === 'remote.crewFormation' && selectRoutes !== undefined
      ? { selectRoutes }
      : undefined),
  } as never
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
      report,
    )
    await controller.load()
    expect(controller.store.getSnapshot().options).toEqual([{ id: 'a', name: 'A' }])
    expect(controller.store.getSnapshot().selected).toBe('a')
  })

  it('stages the combination it opens on, so an untouched picker still applies', async () => {
    const controller = new CrewChoiceController(
      ctxWith(() => Promise.resolve({ ok: true, value: true })),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'b' }),
      report,
    )
    await controller.load()
    // The picker showed "B"; the session must run "B" without the user
    // triggering an onChange on a control that already displayed it.
    expect(controller.stage()).toBe('b')
  })

  it('keeps a staged pick across a refresh instead of reopening on the library default', async () => {
    const controller = new CrewChoiceController(
      ctxWith(() => Promise.resolve({ ok: true, value: true })),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'a' }),
      report,
    )
    await controller.load()
    controller.select('b')
    await controller.load()
    expect(controller.stage()).toBe('b')
    expect(controller.store.getSnapshot().selected).toBe('b')
  })

  it('reports an unserved deployment instead of failing on an undeclarable namespace', async () => {
    const controller = new CrewChoiceController(
      ctxWith(undefined),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toBe(t('crewChoiceUnserved'))
    // The stage survives so a deployment that mounts the formation later, or a
    // fixed route, can still record it.
    expect(controller.stage()).toBe('a')
  })

  it('offers nothing when the Host serves no combination namespace', async () => {
    const controller = new CrewChoiceController(
      ctxWith(() => Promise.resolve({ ok: true, value: true })),
      undefined,
      report,
    )
    await controller.load()
    expect(controller.store.getSnapshot().options).toEqual([])
  })

  it('records the staged combination as the formation routes', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }), report)
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
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [] }), report)
    await controller.load()
    expect(await controller.applyToSession('session-1' as never)).toBeUndefined()
    expect(selectRoutes).not.toHaveBeenCalled()
  })

  it('surfaces a Host refusal and keeps the stage for a retry', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: false, error: { message: 'unknown model' } }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }), report)
    await controller.load()
    controller.select('a')
    const reported = t('crewChoiceRefused', { reason: 'unknown model' })
    expect(await controller.applyToSession('session-1' as never)).toBe(reported)
    expect(controller.store.getSnapshot().error).toBe(reported)
    // The stage survives so a corrected pick does not silently fall back to
    // whatever the library default is.
    expect(controller.stage()).toBe('a')
  })

  it('refuses a combination that vanished between staging and applying', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }), report)
    await controller.load()
    controller.select('a')
    // The Host answered an empty library after the pick was staged.
    const dropped = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [] }), report)
    await dropped.load()
    dropped.select('a')
    expect(await dropped.applyToSession('session-1' as never)).toBe(t('crewChoiceGone'))
    expect(selectRoutes).not.toHaveBeenCalled()
  })

  it('refuses a combination that does not name all three roles', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const partial = [{ namespace: WORKER, provider: 'a', model: 'b', reasoningEffort: 'c' }]
    const controller = new CrewChoiceController(ctxWith(selectRoutes), library({ presets: [{ id: 'a', name: 'A', routes: partial }] }), report)
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toBe(t('crewChoiceIncomplete'))
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
    fireEvent.click(screen.getByLabelText(t('crewChoiceLabel')))
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Fast', 'Deep'])
  })

  it('shows the combination it will apply, not an empty label', () => {
    mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    expect(screen.getByLabelText(t('crewChoiceLabel')).textContent).toContain('Fast')
  })

  it('stages the picked combination', () => {
    const { select } = mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    fireEvent.click(screen.getByLabelText(t('crewChoiceLabel')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deep' }))
    expect(select).toHaveBeenCalledWith('b')
  })
})
