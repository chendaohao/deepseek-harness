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
    : template.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = params[name]
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : ''
    })
}

/** The reporter every controller in this spec is built with. */
const report = (failure: { reason: string; message?: string; recorded?: string }): string => {
  switch (failure.reason) {
    case 'gone': return t('crewChoiceGone')
    case 'incomplete': return t('crewChoiceIncomplete')
    case 'unserved': return t('crewChoiceUnserved')
    case 'conflict': return failure.recorded === undefined
      ? t('crewChoiceConflict')
      : t('crewChoiceConflictNamed', { recorded: failure.recorded })
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

/** One combination library handle whose value can change after the picker mounts. */
function library(value: unknown, overrides: Partial<ConfigFormSnapshot<never>> = {}) {
  let snapshot: ConfigFormSnapshot<never> = {
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
  const listeners = new Set<() => void>()
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: () => Promise.resolve(true),
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(true),
  } as ConfigForm<never>
  return Object.assign(scope, {
    publish: (next: unknown) => {
      snapshot = { ...snapshot, value: next } as never
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  })
}

/**
 * A client context whose formation Remote answers with `selectRoutes` and
 * `view`.
 *
 * `ctx.get` is the read path the controller uses, because the crew bundle is an
 * optional deployment: injecting the namespace would park this plugin forever on
 * a deployment that serves no formation.
 */
function ctxWith(
  selectRoutes: ((...args: unknown[]) => Promise<unknown>) | undefined,
  view?: (...args: unknown[]) => Promise<unknown>,
) {
  return {
    get: (name: string) => (name === 'remote.crewFormation' && selectRoutes !== undefined
      ? { selectRoutes, view }
      : undefined),
    effect: (register: () => (() => void) | undefined) => { register() },
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

  it('opens on a stored combination without staging an automatic Host write', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'b' }),
      report,
    )
    await controller.load()

    expect(controller.store.getSnapshot().selected).toBe('b')
    expect(controller.stage()).toBeUndefined()
    await controller.load()
    await controller.applyToSession('session-1' as never)
    expect(selectRoutes).not.toHaveBeenCalled()
  })

  it('records the displayed combination at send time and does not repeat it', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] })
    const setLastUsed = vi.spyOn(presets, 'set')
    const controller = new CrewChoiceController(ctxWith(selectRoutes), presets, report)
    await controller.load()

    await expect(controller.applyDisplayedToSession('session-1' as never)).resolves.toBeUndefined()
    await expect(controller.applyDisplayedToSession('session-1' as never)).resolves.toBeUndefined()

    expect(selectRoutes).toHaveBeenCalledOnce()
    expect(selectRoutes).toHaveBeenCalledWith('session-1', expect.objectContaining({ presetId: 'a' }))
    expect(setLastUsed).toHaveBeenCalledExactlyOnceWith('lastUsedPresetId', 'a')
    expect(controller.store.getSnapshot().selected).toBe('a')

    // Reaffirming the already-recorded choice is also a local no-op.
    controller.select('a')
    await controller.applyDisplayedToSession('session-1' as never)
    expect(selectRoutes).toHaveBeenCalledOnce()
    expect(controller.stage()).toBeUndefined()
  })

  it('uses an explicit B instead of the displayed A and does not repeat B at send', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('b')

    await expect(controller.applyToSession('session-1' as never)).resolves.toBeUndefined()
    await expect(controller.applyDisplayedToSession('session-1' as never)).resolves.toBeUndefined()

    expect(selectRoutes).toHaveBeenCalledOnce()
    expect(selectRoutes).toHaveBeenCalledWith('session-1', expect.objectContaining({ presetId: 'b' }))
    expect(controller.store.getSnapshot().selected).toBe('b')
  })

  it('allows a different explicit choice after a recorded choice and reports its conflict', async () => {
    const selectRoutes = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'crew/conflict', message: 'A conflicts with B', details: { recordedPresetId: 'b' } },
      })
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('b')
    await controller.applyToSession('session-1' as never)

    controller.select('a')
    const reported = t('crewChoiceConflictNamed', { recorded: 'B' })

    await expect(controller.applyDisplayedToSession('session-1' as never)).resolves.toBeUndefined()
    expect(selectRoutes).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({ selected: 'a', error: reported })
    expect(controller.stage()).toBe('a')
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

  it('refreshes an already mounted picker when its settings document changes', async () => {
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] })
    const controller = new CrewChoiceController(ctxWith(undefined), presets, report)
    await controller.load()
    expect(presets.listenerCount()).toBe(1)

    presets.publish({
      presets: [{ id: 'a', name: 'A renamed', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }],
      lastUsedPresetId: 'b',
    })

    expect(controller.store.getSnapshot()).toMatchObject({
      options: [{ id: 'a', name: 'A renamed' }, { id: 'b', name: 'B' }],
      selected: 'b',
    })
    expect(controller.stage()).toBeUndefined()
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
    await expect(controller.applyDisplayedToSession('session-1' as never)).resolves.toBeUndefined()
  })

  it('records the staged combination as the formation routes', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] })
    const setLastUsed = vi.spyOn(presets, 'set')
    const controller = new CrewChoiceController(ctxWith(selectRoutes), presets, report)
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
    expect(setLastUsed).toHaveBeenCalledExactlyOnceWith('lastUsedPresetId', 'a')
    // The next session can open on this successful choice; the current picker
    // keeps its readable text after the transactional stage is consumed.
    expect(controller.stage()).toBeUndefined()
    expect(controller.store.getSnapshot().selected).toBe('a')
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

  it('reports a conflict by code, keeps the stage, and lets the first prompt through', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({
      ok: false,
      error: { code: 'crew/conflict', message: 'This session already runs another model combination', details: { sessionId: 'session-1', recordedPresetId: 'b', attemptedPresetId: 'a' } },
    }))
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('a')
    const reported = t('crewChoiceConflictNamed', { recorded: 'B' })
    // The session keeps a valid route set, so the conflict is a note about the
    // pick, not a refusal the send path may act on.
    await expect(controller.applyToSession('session-1' as never)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().error).toBe(reported)
    expect(controller.store.getSnapshot().selected).toBe('a')
    expect(controller.stage()).toBe('a')
  })

  it('reports a conflict against an unnamed set without reading the message', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({
      ok: false,
      error: { code: 'crew/conflict', message: 'This session already runs another model combination', details: { sessionId: 'session-1', recordedPresetId: null, attemptedPresetId: 'a' } },
    }))
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('a')
    await expect(controller.applyToSession('session-1' as never)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().error).toBe(t('crewChoiceConflict'))
    expect(controller.stage()).toBe('a')
  })

  it('treats a lost race onto the same combination as success and consumes the stage', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: false }))
    const view = vi.fn(() => Promise.resolve({
      ok: true,
      value: {
        sessionId: 'session-1',
        presetId: 'a',
        presetName: 'A',
        routes: [
          { role: 'worker', provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' },
          { role: 'planner', provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' },
          { role: 'reviewer', provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' },
        ],
        replaced: [],
      },
    }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes, view), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }] }), report)
    await controller.load()
    controller.select('a')
    expect(await controller.applyToSession('session-1' as never)).toBeUndefined()
    expect(controller.stage()).toBeUndefined()
  })

  it('reports the winner and keeps the stage when a race settles on another combination', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: false }))
    const view = vi.fn(() => Promise.resolve({
      ok: true,
      value: {
        sessionId: 'session-1',
        presetId: 'b',
        presetName: 'B',
        routes: [
          { role: 'worker', provider: 'z', model: 'z', reasoningEffort: 'low' },
          { role: 'planner', provider: 'z', model: 'z', reasoningEffort: 'low' },
          { role: 'reviewer', provider: 'z', model: 'z', reasoningEffort: 'low' },
        ],
        replaced: [],
      },
    }))
    const controller = new CrewChoiceController(ctxWith(selectRoutes, view), library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] }), report)
    await controller.load()
    controller.select('a')
    const reported = t('crewChoiceConflictNamed', { recorded: 'B' })
    await expect(controller.applyToSession('session-1' as never)).resolves.toBeUndefined()
    expect(controller.store.getSnapshot().error).toBe(reported)
    expect(controller.stage()).toBe('a')
  })

  it('does not let a late A response consume or overwrite a newer B selection', async () => {
    const first = Promise.withResolvers<unknown>()
    const selectRoutes = vi.fn(() => first.promise)
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] })
    const setLastUsed = vi.spyOn(presets, 'set')
    const controller = new CrewChoiceController(ctxWith(selectRoutes), presets, report)
    await controller.load()
    controller.select('a')
    const applyingA = controller.applyToSession('session-1' as never)

    controller.select('b')
    first.resolve({ ok: true, value: true })

    await expect(applyingA).resolves.toBeUndefined()
    expect(controller.stage()).toBe('b')
    expect(controller.store.getSnapshot()).toMatchObject({ selected: 'b', error: null })
    expect(setLastUsed).not.toHaveBeenCalled()
  })

  it('does not publish a late refusal for a replaced selection', async () => {
    const first = Promise.withResolvers<unknown>()
    const selectRoutes = vi.fn(() => first.promise)
    const controller = new CrewChoiceController(
      ctxWith(selectRoutes),
      library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] }),
      report,
    )
    await controller.load()
    controller.select('a')
    const applyingA = controller.applyToSession('session-1' as never)
    controller.select('b')

    first.resolve({
      ok: false,
      error: { code: 'crew/conflict', message: 'A lost', details: { recordedPresetId: null } },
    })

    await expect(applyingA).resolves.toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({ selected: 'b', error: null })
    expect(controller.stage()).toBe('b')
  })

  it('does not clear a newer selection’s report when an older last-used write settles', async () => {
    const lastUsed = Promise.withResolvers<boolean>()
    const selectRoutes = vi.fn((...args: unknown[]) => {
      const input = args[1] as { presetId: string }
      return Promise.resolve(
        input.presetId === 'a'
          ? { ok: true, value: true }
          : { ok: false, error: { code: 'crew/conflict', message: 'B lost', details: { recordedPresetId: 'a' } } },
      )
    })
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] })
    const setLastUsed = vi.spyOn(presets, 'set').mockReturnValue(lastUsed.promise)
    const controller = new CrewChoiceController(ctxWith(selectRoutes), presets, report)
    await controller.load()
    controller.select('a')
    const applyingA = controller.applyToSession('session-1' as never)
    await vi.waitFor(() => { expect(setLastUsed).toHaveBeenCalledOnce() })

    controller.select('b')
    const reported = t('crewChoiceConflictNamed', { recorded: 'A' })
    await expect(controller.applyToSession('session-1' as never)).resolves.toBeUndefined()
    lastUsed.resolve(true)
    await applyingA

    expect(controller.store.getSnapshot()).toMatchObject({ selected: 'b', error: reported })
    expect(controller.stage()).toBe('b')
  })

  it('unsets a deleted last-used pointer without clearing another combination’s pointer', async () => {
    const selectRoutes = vi.fn(() => Promise.resolve({ ok: true, value: true }))
    const presets = library({ presets: [{ id: 'a', name: 'A', routes: ROUTES }, { id: 'b', name: 'B', routes: ROUTES }] })
    const unsetLastUsed = vi.spyOn(presets, 'unset')
    const controller = new CrewChoiceController(ctxWith(selectRoutes), presets, report)
    await controller.load()

    presets.publish({ presets: [{ id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'b' })
    await controller.load()
    expect(unsetLastUsed).not.toHaveBeenCalled()

    presets.publish({ presets: [{ id: 'b', name: 'B', routes: ROUTES }], lastUsedPresetId: 'a' })
    await vi.waitFor(() => { expect(unsetLastUsed).toHaveBeenCalledExactlyOnceWith('lastUsedPresetId') })
    expect(selectRoutes).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().selected).toBe('b')
  })

  it('reports a failed stale-pointer cleanup without rejecting the settings refresh', async () => {
    const presets = library({ presets: [], lastUsedPresetId: 'a' })
    vi.spyOn(presets, 'unset').mockRejectedValue(new Error('settings write failed'))
    const controller = new CrewChoiceController(ctxWith(undefined), presets, report)

    await controller.load()

    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().error).toBe(t('crewChoiceRefused', { reason: 'settings write failed' }))
    })
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
      } as CrewChoiceProps)} />,
    )
    return { select }
  }

  it('draws nothing while another preset is staged', () => {
    mount('standard', [{ id: 'a', name: 'Fast' }])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('draws nothing while the deployment stores no combination', () => {
    mount('crew', [])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers every stored combination while crew is staged', () => {
    mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    fireEvent.click(screen.getByRole('button', { name: t('crewChoiceTriggerLabel', { name: 'Fast' }) }))
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Fast', 'Deep'])
  })

  it('shows the combination it will apply, not an empty label', () => {
    mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    expect(screen.getByRole('button', { name: t('crewChoiceTriggerLabel', { name: 'Fast' }) }).textContent).toContain('Fast')
  })

  it('stages the picked combination', () => {
    const { select } = mount('crew', [{ id: 'a', name: 'Fast' }, { id: 'b', name: 'Deep' }])
    fireEvent.click(screen.getByRole('button', { name: t('crewChoiceTriggerLabel', { name: 'Fast' }) }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deep' }))
    expect(select).toHaveBeenCalledWith('b')
  })
})
