// @vitest-environment jsdom
/**
 * Conversation-adjacent surfaces: the new-session chip and combination picker
 * naming the next session's choices, and the session header's read-only label.
 * The split is the host's rule — a session's history is produced under its
 * preset's tools, so the choice is only ever offered before one starts.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionRetainInfo } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelProps } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import { CrewChoice } from '../src/client/CrewChoice.tsx'
import type { CrewChoiceInjected, CrewChoiceProps } from '../src/client/CrewChoice.tsx'
import { apply as applyAgentPreset, inject as agentPresetInject } from '../src/client/index.ts'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import type { CrewRoutesState } from '../src/client/crew-routes-view.ts'
import type { CrewRouteCatalogOutcome, CrewRouteRepairOutcome } from '../src/client/CrewRouteRepairDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROSTER_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  options: [{ id: 'standard' }, { id: 'mine' }],
}

const SEAT_READY: AgentPresetSeatState = {
  current: 'standard',
  options: [
    { id: 'standard' },
    { id: 'mine' },
  ],
  busy: false,
  error: null,
  introduce: false,
}

const CATALOG: Extract<CrewRouteCatalogOutcome, { ok: true }>['value'] = {
  default: { provider: 'deepseek', model: 'worker-model', reasoningEffort: 'high' },
  routableProviders: ['deepseek', 'tierflow'],
  groups: [
    {
      id: 'deepseek', name: 'DeepSeek',
      models: [
        { id: 'worker-model', name: 'Worker model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
        { id: 'planner-model', name: 'Planner model' },
        { id: 'reviewer-model', name: 'Reviewer model' },
      ],
    },
    {
      id: 'tierflow', name: 'Tierflow',
      models: [{ id: 'tierflow-pro', name: 'Tierflow Pro', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }],
    },
  ],
  failures: [],
}

const COMBINATION_ROUTES = [
  { namespace: 'crew-worker-route-settings', provider: 'deepseek', model: 'worker-model', reasoningEffort: 'high' },
  { namespace: 'crew-planner-route-settings', provider: 'deepseek', model: 'planner-model', reasoningEffort: 'medium' },
  { namespace: 'crew-reviewer-route-settings', provider: 'deepseek', model: 'reviewer-model', reasoningEffort: 'low' },
] as const

interface CombinationDocument {
  presets: readonly {
    id: string
    name: string
    routes: readonly (typeof COMBINATION_ROUTES)[number][]
  }[]
  lastUsedPresetId?: string
}

const COMBINATIONS: CombinationDocument['presets'] = [
  { id: 'night', name: 'Night shift', routes: COMBINATION_ROUTES },
  { id: 'day', name: 'Day shift', routes: COMBINATION_ROUTES },
]

const useSessionRetainInfo = <Selected,>(selector: (value: undefined) => Selected): Selected => selector(undefined)

/** The runtime's own `{name}` substitution, so a test reads the shown text. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function renderSeat(
  state: Partial<AgentPresetSeatState> = {},
  select: () => Promise<string | undefined> = () => Promise.resolve(undefined),
  session?: { id: string; retainInfo: SessionRetainInfo | undefined },
  enabled = true,
) {
  const store = createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, ...state })
  const developerTools = createSnapshotStore(enabled)
  const actions = {
    load: vi.fn(() => Promise.resolve()), select: vi.fn(select), introduced: vi.fn(),
    dismissRefusal: vi.fn((error: AgentPresetSeatState['error']) => {
      if (store.getSnapshot().error === error && error !== null && typeof error === 'object') {
        store.set({ ...store.getSnapshot(), error: error.reason })
      }
    }),
  }
  const props = {
    ...actions,
    sessionId: session === undefined ? undefined : SessionId(session.id),
    useDeveloperTools: bindSnapshotSelector(developerTools),
    useAgentPresetSeat: bindSnapshotSelector(store),
    useSessionRetainInfo: session === undefined
      ? useSessionRetainInfo
      : <Selected,>(selector: (value: SessionRetainInfo | undefined) => Selected) => selector(session.retainInfo),
    t: translate,
  } as AgentPresetSeatProps
  render(<AgentPresetSeat {...props} />)
  return { ...actions, developerTools, store }
}

function renderLabel(
  summary: { blank: boolean; projectionValues?: { agentPreset?: string | null } } | undefined,
  roster: Partial<AgentPresetSettingsState> = {},
  crew: CrewRoutesState = { status: 'loading' },
) {
  // The chip and the label read the same roster, metadata included.
  const store = createSnapshotStore<AgentPresetSettingsState>({
    ...ROSTER_READY, options: SEAT_READY.options, ...roster,
  })
  const sessions = createSnapshotStore({ byId: summary === undefined ? {} : { s1: summary } })
  const crewRoutes = createSnapshotStore<CrewRoutesState>(crew)
  const load = vi.fn(() => Promise.resolve())
  const loadCrewRoutes = vi.fn(() => Promise.resolve())
  const loadCrewRouteCatalog = vi.fn(async (): Promise<CrewRouteCatalogOutcome> => ({ ok: true, value: CATALOG }))
  const replaceCrewRole = vi.fn(async (): Promise<CrewRouteRepairOutcome> => ({ ok: true }))
  const view = render(<AgentPresetLabel {...({
    load,
    loadCrewRoutes,
    loadCrewRouteCatalog,
    replaceCrewRole,
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions),
    useAgentPresets: bindSnapshotSelector(store),
    useCrewRoutes: bindSnapshotSelector(crewRoutes),
    t: translate,
  } as AgentPresetLabelProps)} />)
  return { load, loadCrewRoutes, loadCrewRouteCatalog, replaceCrewRole, crewRoutes, view }
}

/** Narrow the registry's erased inject payload without an unknown cast. */
function isCrewChoiceInjected(value: unknown): value is CrewChoiceInjected {
  return typeof value === 'object' && value !== null && 'hooks' in value && 'load' in value && 'select' in value
}

/** Mount the real combination registration over in-memory settings and Remotes. */
async function mountChoice(mainBlankCrew = false) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'plugins.add.actions': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  slots.register({
    name: 'conversation',
    children: {
      'conversation.hero.options': { kind: 'list', scope: 'session-maybe' },
      'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)

  const tools = stubConfigForm<{ enabled: boolean }>()
  const presetSettings = stubConfigForm<{ selectedDefault: string }>()
  const combinations = stubConfigForm<CombinationDocument>()
  tools.publish({ status: 'ready', value: { enabled: true }, revision: 0 })
  presetSettings.publish({ status: 'ready', value: { selectedDefault: 'standard' }, revision: 0 })
  combinations.publish({ status: 'ready', value: { presets: COMBINATIONS }, revision: 0 })
  ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: (namespace: string) => {
      if (namespace === 'ui-settings') return tools.scope
      if (namespace === 'agent-preset-registry') return presetSettings.scope
      return combinations.scope
    },
  } as never)

  const agentPresets = {
    list: vi.fn(() => Promise.resolve({ ok: true as const, value: { presets: [
      { id: 'standard', isDefault: true }, { id: 'crew', isDefault: false },
    ] } })),
  }
  const settings = { update: vi.fn() }
  const session = { modelCatalog: vi.fn() }
  const remote = { $on: vi.fn(() => () => {}), agentPresets, settings, session }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.agentPresets', agentPresets as never)
  ctx.provide('remote.settings', settings as never)
  ctx.provide('remote.session', session as never)
  const selectRoutes = vi.fn(() => Promise.resolve({ ok: true as const, value: true }))
  ctx.provide('remote.crewFormation', { selectRoutes } as never)

  const sessionId = SessionId('blank')
  const binding = { sessionId, ctx }
  const summary = mainBlankCrew
    ? { id: sessionId, blank: true, projectionValues: { agentPreset: 'crew' }, retainedBy: { mainView: 1 } }
    : undefined
  const sessions = {
    list: {
      getSnapshot: () => ({ byId: summary === undefined ? {} : { blank: summary } }),
      subscribe: () => () => {},
    },
    binding: (id: string) => summary !== undefined && id === 'blank' ? binding : undefined,
    retainInfo: () => ({
      getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }),
      subscribe: () => () => {},
    }),
  }
  ctx.provide('sessions', sessions as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('uiWorkspace', { startSession: vi.fn() } as never)
  await ctx.plugin({ inject: [...agentPresetInject], apply: applyAgentPreset }).await()
  const entry = slots.entries('conversation.hero.options').find(candidate => candidate.options.id === 'crew-model-combination')
  if (entry === undefined) throw new Error('Crew combination registration missing')
  const injected: unknown = entry.inject?.()
  if (!isCrewChoiceInjected(injected)) throw new Error('Crew combination inject payload is invalid')
  return { ctx, combinations, injected, selectRoutes }
}

/** Render a mounted picker with the same hook binding the renderer supplies. */
async function renderMountedChoice(injected: CrewChoiceInjected) {
  const props = {
    load: injected.load,
    select: injected.select,
    useCrewChoice: bindSnapshotSelector(injected.hooks.crewChoice),
    useAgentPresetSeat: bindSnapshotSelector(injected.hooks.agentPresetSeat),
    t: translate,
  } as CrewChoiceProps
  render(<CrewChoice {...props} />)
  await act(async () => { await injected.load() })
  act(() => {
    const seat = injected.hooks.agentPresetSeat
    seat.set({ ...seat.getSnapshot(), current: 'crew' })
  })
}

describe('the crew combination picker', () => {
  it('names its trigger with the current combination', async () => {
    const mounted = await mountChoice()
    try {
      await renderMountedChoice(mounted.injected)
      expect(screen.getByRole('button', {
        name: translate('crewChoiceTriggerLabel', { name: 'Night shift' }),
      })).toBeTruthy()
      act(() => { mounted.injected.select('day') })
      expect(screen.getByRole('button', {
        name: translate('crewChoiceTriggerLabel', { name: 'Day shift' }),
      })).toBeTruthy()
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('reloads an already-mounted picker when combination settings move', async () => {
    const mounted = await mountChoice()
    try {
      await renderMountedChoice(mounted.injected)
      expect(mounted.combinations.listenerCount()).toBe(1)
      act(() => {
        mounted.combinations.publish({
          value: { presets: [{ ...COMBINATIONS[0]!, name: 'Night shift revised' }, COMBINATIONS[1]!] },
        })
      })
      expect(screen.getByRole('button', {
        name: translate('crewChoiceTriggerLabel', { name: 'Night shift revised' }),
      })).toBeTruthy()
    } finally {
      await mounted.ctx.fiber.dispose()
    }
    expect(mounted.combinations.listenerCount()).toBe(0)
  })

  it('submits the displayed combination on the first send without repeating it', async () => {
    const mounted = await mountChoice(true)
    try {
      await renderMountedChoice(mounted.injected)
      const gate = mounted.ctx.get('agentPresetSeat') as {
        pendingApply(): Promise<{ readonly kind: string }>
      }
      await gate.pendingApply()
      expect(mounted.selectRoutes).toHaveBeenCalledTimes(1)
      expect(mounted.selectRoutes).toHaveBeenCalledWith(SessionId('blank'), expect.objectContaining({
        presetId: 'night', presetName: 'Night shift',
      }))
      await gate.pendingApply()
      expect(mounted.selectRoutes).toHaveBeenCalledTimes(1)
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('applies an explicit replacement to the current Crew blank instead of only renaming it', async () => {
    const mounted = await mountChoice(true)
    try {
      await renderMountedChoice(mounted.injected)
      expect(mounted.selectRoutes).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', {
        name: translate('crewChoiceTriggerLabel', { name: 'Night shift' }),
      }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Day shift' }))
      await waitFor(() => {
        expect(mounted.selectRoutes).toHaveBeenCalledWith(SessionId('blank'), expect.objectContaining({
          presetId: 'day', presetName: 'Day shift',
        }))
      })
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })
})

describe('the new-session chip', () => {
  it.each([false, true])('offers Standard, Creator and custom presets with Developer tools %s', (enabled) => {
    const actions = renderSeat({ options: [
      { id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }, { id: 'mine' },
    ] }, undefined, undefined, enabled)

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('menuitem')).toHaveLength(enabled ? 5 : 3)
    expect(screen.getByRole('menuitem', { name: /^Standard mode/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^mine/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^PTC mode/ }) !== null).toBe(enabled)
    expect(screen.queryByRole('menuitem', { name: /^Minimal mode/ }) !== null).toBe(enabled)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Creator mode/ }))
    expect(actions.select).toHaveBeenCalledWith('cordis')
  })

  it('keeps a named custom preset that overrides a development preset id', () => {
    renderSeat({ options: [{ id: 'ptc', name: 'My workflow' }] }, undefined, undefined, false)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('menuitem', { name: /^My workflow/ })).toBeTruthy()
  })

  it('keeps the current mode visible without opening a picker when all options are hidden', () => {
    const actions = renderSeat({ current: 'minimal', options: [{ id: 'ptc' }, { id: 'minimal' }] }, undefined, undefined, false)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: en.presetMinimalName })
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
  })

  it('closes a picker when its last visible option disappears and keeps it closed when options return', () => {
    const options = [{ id: 'minimal' }, { id: 'mine' }]
    const actions = renderSeat({ current: 'minimal', options }, undefined, undefined, false)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: en.presetMinimalName })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: /^mine/ })).toBeTruthy()
    act(() => { actions.store.set({ ...actions.store.getSnapshot(), options: [{ id: 'ptc' }, { id: 'minimal' }] }) })
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { actions.store.set({ ...actions.store.getSnapshot(), options }) })
    expect(trigger.disabled).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
  })

  it('renders only for a Session retained by the main view', () => {
    renderSeat({}, undefined, {
      id: 's1', retainInfo: { referenceCount: 1, retainedBy: { mainView: 1 } },
    })
    expect(screen.getByRole('button')).toBeTruthy()
    cleanup()

    renderSeat({}, undefined, { id: 's1', retainInfo: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads the roster once and shows the staged preset by name', async () => {
    const actions = renderSeat()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
    expect(screen.getByRole('button').getAttribute('title')).toBe(en.seatHint)
  })

  it('offers each preset with what it is for', () => {
    renderSeat()

    fireEvent.click(screen.getByRole('button'))

    // The id alone never said what a preset does; the description is the
    // whole reason a preset can publish metadata at all.
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    // A preset that published none still reads as a row, with its id standing
    // in for the name.
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(screen.getByText('mine')).toBeTruthy()
  })

  it('closes the picker immediately when developer tools turn off without changing the staged preset', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    act(() => { actions.developerTools.set(false) })
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.presetStandardDescription)).toBeNull()
    expect(actions.select).not.toHaveBeenCalled()
    act(() => { actions.developerTools.set(true) })
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
  })

  it('falls back to the id when the staged preset published no name', () => {
    renderSeat({ current: 'mine' })

    expect(screen.getByRole('button').textContent).toContain('mine')
  })

  it('shows the staged id until a stale roster contains it', () => {
    renderSeat({ current: 'arriving' })

    expect(screen.getByRole('button').textContent).toContain('arriving')
  })

  it('stages the picked preset and closes the menu', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText('mine'))

    expect(actions.select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('disables the trigger while a switch is in flight', () => {
    renderSeat({ busy: true })

    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })

  it('shows a refused switch on the trigger', () => {
    renderSeat({ error: 'session has already started' })

    expect(screen.getByRole('button').getAttribute('title')).toBe('session has already started')
  })

  it('renders nothing before the roster arrives or when there is none', () => {
    const empty = renderSeat({ options: [] })
    expect(empty).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    renderSeat({ current: '' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a refused switch', () => {
  it('announces delayed and repeated refusals even without a composed preset or Coding Tools', () => {
    // The banner's own timer has to be a fake one from the start, or the
    // lifetime assertion below would wait out its real nine seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const reason = 'failed to import loader entry live-on-mac (@deepseek-ai/dsh-also-gone)'
      const actions = renderSeat({ current: '' }, undefined, undefined, false)
      const refusal = { preset: { id: 'cordis' }, reason }
      act(() => { actions.store.set({ ...actions.store.getSnapshot(), error: refusal }) })

      // The host refuses a mount discovery reported healthy, so this banner is
      // the only place the cause appears — the chip has already reverted and
      // the settings row shows the preset as fine.
      const banner = screen.getByRole('alert')
      expect(banner.textContent).toContain(reason)
      expect(banner.textContent).toContain(en.presetCordisName)
      expect(screen.queryByRole('button')).toBeNull()

      act(() => { vi.advanceTimersByTime(7000) })
      act(() => { actions.store.set({ ...actions.store.getSnapshot(), error: { ...refusal } }) })
      act(() => { vi.advanceTimersByTime(2001) })
      expect(screen.getByRole('alert').textContent).toContain(reason)

      // Transient by design: it holds long enough to read a cause that names
      // packages, then leaves rather than sitting over the screen.
      act(() => { vi.advanceTimersByTime(9001) })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(actions.dismissRefusal).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the switch lands', async () => {
    const actions = renderSeat()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

    await waitFor(() => { expect(actions.select).toHaveBeenCalledWith('mine') })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the chip introduce cue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Character spans carry inline animation delays; nothing else does. */
  function delayedChars(): HTMLElement[] {
    return Array.from(screen.getByRole('button').querySelectorAll<HTMLElement>('[style]'))
  }

  it('reveals a long Latin name inside the shared window, then acknowledges', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'CreatorMode' }],
      introduce: true,
    })

    // Eleven characters split the 200ms window into 20ms steps, where the
    // fixed 40ms tick would have doubled the run for a Latin name.
    const chars = delayedChars()
    expect(chars.map(span => span.textContent).join('')).toBe('CreatorMode')
    expect(chars[0]!.style.animationDelay).toBe('150ms')
    expect(chars[1]!.style.animationDelay).toBe('170ms')
    expect(chars[10]!.style.animationDelay).toBe('350ms')

    // 150 delay + 200 window + 400 fade: acknowledged only once the last
    // character has settled, and the label is plain text again after.
    act(() => { vi.advanceTimersByTime(749) })
    expect(actions.introduced).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('keeps the per-tick cap for a short CJK name', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '创造模式' }],
      introduce: true,
    })

    // Four characters fit under the window, so the 40ms tick applies as-is.
    const chars = delayedChars()
    expect(chars).toHaveLength(4)
    expect(chars[1]!.style.animationDelay).toBe('190ms')
    expect(chars[3]!.style.animationDelay).toBe('270ms')
  })

  it('starts a one-character name with no stagger at all', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: 'C' }],
      introduce: true,
    })

    expect(delayedChars()[0]!.style.animationDelay).toBe('150ms')
    act(() => { vi.advanceTimersByTime(550) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
  })

  it('skips the run under reduced motion and acknowledges at once', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const actions = renderSeat({ introduce: true })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('acknowledges an empty staged name without arming a run', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', name: '' }],
      introduce: true,
    })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })
})

describe('the session-header label', () => {
  it('names the preset the session runs, and never offers a switch', async () => {
    const { load } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    // A control here would promise a switch the host refuses outright.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(en.presetStandardName)).toBeTruthy()
    expect(screen.getByRole('img', { name: en.presetStandardName })).toBeTruthy()
  })

  it('falls back to the id, and to the generic hint, when metadata is absent', () => {
    renderLabel({ blank: true, projectionValues: { agentPreset: 'mine' } })

    expect(screen.getByRole('img', { name: 'mine' })).toBeTruthy()
    expect(screen.getByText('mine')).toBeTruthy()
  })

  it('shows the id until the roster resolves it', () => {
    renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    }, { options: [] })

    // The session's own summary is the authority on which preset it runs; the
    // roster only supplies the display name, and its arrival is a later frame.
    expect(screen.getByRole('img', { name: 'standard' })).toBeTruthy()
  })

  it('pins the description open on tap, the only way a touch device can read it', () => {
    // The bubble paints only after ResizeObserver reports its size, and
    // getByRole skips a visibility:hidden node, so the double delivers one.
    stubBubbleObserver()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, addEventListener: () => {}, removeEventListener: () => {},
    })))
    try {
      renderLabel({
        blank: false,
        projectionValues: { agentPreset: 'standard' },
      })

      // The native title attribute never shows on touch; the pinned bubble is
      // the mobile-readable explanation (responsive UI: tap-to-show).
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.click(screen.getByRole('img', { name: en.presetStandardName }))
      expect(screen.getByRole('tooltip').textContent).toBe(en.presetStandardDescription)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders nothing, and reads no roster, when the session records no preset', async () => {
    const absent = renderLabel({ blank: true })
    expect(absent.view.container.firstChild).toBeNull()
    cleanup()

    // A session the list has not caught up to is the same answer: a deployment
    // that composes no presets must not pay for a roster read per header.
    const unknown = renderLabel(undefined)
    expect(unknown.view.container.firstChild).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(absent.load).not.toHaveBeenCalled()
    expect(unknown.load).not.toHaveBeenCalled()
  })
})

const CREW_SESSION = { blank: false, projectionValues: { agentPreset: 'crew' } }

/** A recorded combination covering all three roles with distinguishable routes. */
const RECORDED: Extract<CrewRoutesState, { status: 'ready-with-routes' }> = {
  status: 'ready-with-routes',
  presetName: 'Night shift',
  routes: [
    { role: 'worker', provider: 'deepseek', model: 'worker-model', reasoningEffort: 'high' },
    { role: 'planner', provider: 'deepseek', model: 'planner-model', reasoningEffort: 'medium' },
    { role: 'reviewer', provider: 'deepseek', model: 'reviewer-model', reasoningEffort: 'low' },
  ],
}

/** The three bubble lines a recorded combination produces. */
const ROUTE_LINES = [
  { role: 'crewRoutesWorker', model: 'worker-model', effort: 'high' },
  { role: 'crewRoutesPlanner', model: 'planner-model', effort: 'medium' },
  { role: 'crewRoutesReviewer', model: 'reviewer-model', effort: 'low' },
].map(entry => translate('crewRoutesRoute', {
  role: en[entry.role as keyof typeof en],
  provider: 'deepseek',
  model: entry.model,
  reasoningEffort: entry.effort,
}))

/** Install the ResizeObserver double that makes the shared Tooltip paintable. */
function stubBubbleObserver(): void {
  class BubbleObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const size = { inlineSize: 120, blockSize: 40 }
      this.callback([{
        target, contentRect: new DOMRect(0, 0, size.inlineSize, size.blockSize),
        borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size],
      }], this)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', BubbleObserver)
}

describe('the crew session-header label', () => {
  it('says the recorded combination is still being read while the read is in flight', async () => {
    const { load, loadCrewRoutes } = renderLabel(CREW_SESSION, {}, { status: 'loading' })

    await waitFor(() => { expect(loadCrewRoutes).toHaveBeenCalledTimes(1) })
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('img', { name: en.crewRoutesLoading })).toBeTruthy()
    expect(screen.getByText(en.crewRoutesLoading)).toBeTruthy()
    // Reading is not a result: no combination is claimed and nothing is offered.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names the recorded combination and lists every role route in its menu', () => {
    renderLabel(CREW_SESSION, {}, RECORDED)

    const applied = translate('crewRoutesApplied', { name: 'Night shift' })
    const trigger = screen.getByRole('button', { name: applied })
    expect(trigger.textContent).toBe(applied)
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')

    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    // All three roles: a combination the session did not record would be a claim.
    for (const line of ROUTE_LINES) expect(menu.textContent).toContain(line)
    // The trigger already names the combination, so the menu does not repeat it.
    expect(menu.textContent).not.toContain(applied)
    expect(within(menu).getByRole('menuitem', { name: en.crewRouteRepairAction })).toBeTruthy()
  })

  it('says the roles run their own defaults when the session recorded no combination', () => {
    renderLabel(CREW_SESSION, {}, { status: 'ready-without-routes' })

    expect(screen.getByRole('img', { name: en.crewRoutesUnapplied })).toBeTruthy()
    expect(screen.getByText(en.crewRoutesUnapplied)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reports a deployment without the crew formation instead of a combination', () => {
    renderLabel(CREW_SESSION, {}, { status: 'unavailable' })

    expect(screen.getByRole('img', { name: en.crewRoutesUnavailable })).toBeTruthy()
    expect(screen.getByText(en.crewRoutesUnavailable)).toBeTruthy()
    // An unreadable deployment never wears the applied face.
    expect(screen.queryByText(translate('crewRoutesApplied', { name: 'Night shift' }))).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reports a failed read and re-reads only when the retry is used', async () => {
    const { loadCrewRoutes, crewRoutes } = renderLabel(CREW_SESSION, {}, {
      status: 'error', message: 'gateway disconnected',
    })

    const trigger = screen.getByRole('button', { name: en.crewRoutesError })
    await waitFor(() => { expect(loadCrewRoutes).toHaveBeenCalledTimes(1) })

    // The retry is the only interaction: it re-reads, it never changes the session.
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: en.crewRoutesRetry }))
    expect(loadCrewRoutes).toHaveBeenCalledTimes(2)

    // Whatever the retry finds is what the header then says.
    act(() => { crewRoutes.set({ status: 'ready-without-routes' }) })
    expect(screen.getByRole('img', { name: en.crewRoutesUnapplied })).toBeTruthy()
  })

  it('keeps a long combination name whole for assistive technology and the trigger', () => {
    const name = 'night-shift-with-a-very-long-combination-name-that-the-header-cannot-fit'
    renderLabel(CREW_SESSION, {}, { ...RECORDED, presetName: name })

    const applied = translate('crewRoutesApplied', { name })
    // The visible span may ellipsize in CSS, but neither the DOM text nor the
    // accessible name is cut: both carry the whole name.
    const trigger = screen.getByRole('button', { name: applied })
    expect(trigger.textContent).toBe(applied)
  })

  it('keeps the role routes reachable by keyboard on the menu trigger', () => {
    renderLabel(CREW_SESSION, {}, RECORDED)

    const trigger = screen.getByRole('button', { name: translate('crewRoutesApplied', { name: 'Night shift' }) })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    for (const line of ROUTE_LINES) expect(screen.getByRole('menu').textContent).toContain(line)
  })

  it('names a record that lost its source combination name', () => {
    renderLabel(CREW_SESSION, {}, { ...RECORDED, presetName: null })

    // The routes are still the session's own; only the template's name is gone,
    // so the label says so instead of inventing one.
    const applied = translate('crewRoutesApplied', { name: en.crewRoutesUnnamed })
    expect(screen.getByRole('button', { name: applied })).toBeTruthy()
    expect(screen.getByText(applied)).toBeTruthy()
  })

  it('closes the combination menu without acting on it', () => {
    const { loadCrewRoutes } = renderLabel(CREW_SESSION, {}, RECORDED)

    const trigger = screen.getByRole('button', { name: translate('crewRoutesApplied', { name: 'Night shift' }) })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    // A dismissal changes nothing: the reading stays, and no route was re-read.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(loadCrewRoutes).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})


/**
 * Open the combination menu on the header chip and pick its repair row.
 *
 * The repair action lives in the chip's own menu rather than beside it, so
 * every dialog test starts here instead of on a bare header button.
 */
function openRepair(): void {
  fireEvent.click(screen.getByRole('button', {
    name: translate('crewRoutesApplied', { name: RECORDED.presetName }),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.crewRouteRepairAction }))
}

describe('the Crew route repair dialog', () => {
  it('names each picker entry once when the catalog name repeats its id', async () => {
    const { loadCrewRouteCatalog } = renderLabel(CREW_SESSION, {}, RECORDED)
    loadCrewRouteCatalog.mockResolvedValueOnce({
      ok: true,
      value: {
        ...CATALOG,
        groups: [{
          id: 'workbuddy',
          name: 'workbuddy',
          models: [{
            id: 'deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' },
          }],
        }],
      },
    })
    openRepair()

    const provider = await screen.findByLabelText<HTMLSelectElement>(en.crewRouteRepairProvider)
    const providerLabels = [...provider.options].map(option => option.textContent)
    // A provider whose display name already is its id reads once; the stored
    // route the catalog no longer advertises still selects itself.
    expect(providerLabels).toContain('workbuddy')
    expect(providerLabels).toContain('deepseek')

    fireEvent.change(provider, { target: { value: 'workbuddy' } })
    const model = screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairModel)
    // Case and separators alone do not make an id worth repeating.
    expect([...model.options].map(option => option.textContent)).toEqual(['Deepseek-V4.1-Flash'])
    expect([...screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairEffort).options]
      .map(option => option.textContent)).toEqual(['Max'])
  })

  it('keeps the id where the display name says something else', async () => {
    const { loadCrewRouteCatalog } = renderLabel(CREW_SESSION, {}, RECORDED)
    loadCrewRouteCatalog.mockResolvedValueOnce({
      ok: true,
      value: {
        ...CATALOG,
        groups: [{ id: 'workbuddy', name: 'WorkBuddy Cloud', models: [] }],
      },
    })
    openRepair()
    const provider = await screen.findByLabelText<HTMLSelectElement>(en.crewRouteRepairProvider)
    // The stored provider the catalog no longer advertises leads as its bare id;
    // the advertised one keeps its id because the name alone does not name it.
    expect([...provider.options].map(option => option.textContent))
      .toEqual(['deepseek', 'WorkBuddy Cloud · workbuddy'])
  })

  it('replaces only the selected role with the chosen catalog route', async () => {
    const { replaceCrewRole } = renderLabel(CREW_SESSION, {}, RECORDED)
    openRepair()
    fireEvent.change(await screen.findByLabelText(en.crewRouteRepairRole), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText(en.crewRouteRepairProvider), { target: { value: 'tierflow' } })
    expect(screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairModel).value).toBe('tierflow-pro')
    expect(screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairEffort).value).toBe('max')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.crewRouteRepairConfirm }))
    await waitFor(() => {
      expect(replaceCrewRole).toHaveBeenCalledWith('reviewer', {
        provider: 'tierflow', model: 'tierflow-pro', reasoningEffort: 'max',
      })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(replaceCrewRole).toHaveBeenCalledTimes(1)
  })

  it('ignores a pending save completed after an earlier dialog was closed and reopened', async () => {
    const { replaceCrewRole } = renderLabel(CREW_SESSION, {}, RECORDED)
    const firstSave = Promise.withResolvers<CrewRouteRepairOutcome>()
    replaceCrewRole.mockReturnValueOnce(firstSave.promise)
    openRepair()
    fireEvent.change(await screen.findByLabelText(en.crewRouteRepairProvider), { target: { value: 'tierflow' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.crewRouteRepairConfirm }))
    expect(replaceCrewRole).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    openRepair()
    expect(await screen.findByLabelText(en.crewRouteRepairProvider)).toBeTruthy()

    await act(async () => {
      firstSave.resolve({ ok: true })
      await firstSave.promise
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText(en.crewRouteRepairProvider)).toBeTruthy()
  })

  it('keeps the selected route visible when the Host refuses the replacement', async () => {
    const { replaceCrewRole } = renderLabel(CREW_SESSION, {}, RECORDED)
    replaceCrewRole.mockResolvedValueOnce({ ok: false, message: 'quota exhausted' })
    openRepair()
    fireEvent.change(await screen.findByLabelText(en.crewRouteRepairProvider), { target: { value: 'tierflow' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.crewRouteRepairConfirm }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', translate('crewRouteRepairFailed', { message: 'quota exhausted' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairProvider).value).toBe('tierflow')
    expect(screen.getByLabelText<HTMLSelectElement>(en.crewRouteRepairModel).value).toBe('tierflow-pro')
  })

  it('retries a failed catalog read without losing the open dialog', async () => {
    const { loadCrewRouteCatalog } = renderLabel(CREW_SESSION, {}, RECORDED)
    loadCrewRouteCatalog.mockResolvedValueOnce({ ok: false, message: 'offline' })
    openRepair()
    expect((await screen.findByRole('alert')).textContent).toContain(translate('crewRouteRepairCatalogFailed', { message: 'offline' }))
    fireEvent.click(screen.getByRole('button', { name: en.crewRoutesRetry }))
    expect(await screen.findByLabelText(en.crewRouteRepairProvider)).toBeTruthy()
    expect(loadCrewRouteCatalog).toHaveBeenCalledTimes(2)
  })
})
