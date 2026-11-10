/**
 * The session header's agent-preset label.
 *
 * The composition is fixed once a conversation starts, so this never offers a
 * preset switch: the choice lives on the new-session screen
 * ({@link AgentPresetSeat}), and naming what the session runs is the honest
 * affordance here.
 *
 * A crew session also names the model combination it recorded, and that
 * reading — the session's own record, not the combination library's current
 * template — is what its menu lists. Every reading other than "recorded" says
 * so in its own words. The menu carries the actions on the combination
 * (changing a role route, reading again after a failure) rather than a row of
 * text buttons beside the label: those buttons spent header width the
 * subagent count needed, and the actions belong to the thing they act on.
 */

import { useEffect, useRef, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { AgentPresetSettingsState } from './settings-store.ts'
import type { CrewRoutesState } from './crew-routes-view.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'
import { CrewRouteRepairDialog, type CrewRouteRepairActions } from './CrewRouteRepairDialog.tsx'

/** The preset whose sessions record a model combination. */
const CREW_PRESET = 'crew'

/** Registration-side business face for the header label. */
export interface AgentPresetLabelInjected extends CrewRouteRepairActions {
  hooks: {
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
    /** This session's recorded combination, bound as useCrewRoutes. */
    crewRoutes: SnapshotStore<CrewRoutesState>
  }
  /** Read the roster, so the label can show a name rather than an id. */
  load: () => Promise<void>
  /** Read the session's recorded combination (also the failed read's retry). */
  loadCrewRoutes: () => Promise<void>
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/** One localized face of a recorded-combination reading. */
interface CrewPresentation {
  /** Text the header shows. */
  label: string
  /** Bubble text: multi-line for the three role routes. */
  hint: string
  /** Whether the reading failed, the only state that offers a retry. */
  retry: boolean
}

/** Dictionary key naming each delegation role. */
const ROLE_KEYS = {
  worker: 'crewRoutesWorker',
  planner: 'crewRoutesPlanner',
  reviewer: 'crewRoutesReviewer',
} as const

/**
 * Turn one reading into the header's copy.
 * @param state - the session's recorded-combination reading.
 * @param crewHint - the crew preset's own description, used while the read is
 * still in flight.
 * @param t - this surface's dictionary.
 * @returns the header text, the bubble text, and whether to offer a retry.
 */
function crewPresentation(
  state: CrewRoutesState,
  crewHint: string | undefined,
  t: TranslateNS<'settings.agentPreset'>,
): CrewPresentation {
  switch (state.status) {
    case 'loading':
      return { label: t('crewRoutesLoading'), hint: crewHint ?? t('headerHint'), retry: false }
    case 'unavailable':
      return { label: t('crewRoutesUnavailable'), hint: t('crewRoutesUnavailableHint'), retry: false }
    case 'error':
      return {
        label: t('crewRoutesError'),
        hint: t('crewRoutesErrorHint', { message: state.message }),
        retry: true,
      }
    case 'ready-without-routes':
      return { label: t('crewRoutesUnapplied'), hint: t('crewRoutesUnappliedHint'), retry: false }
    case 'ready-with-routes':
      // The trigger already names the combination, so the bubble carries only
      // what it cannot: one line per role, wrapping instead of truncating,
      // which keeps three provider/model/effort triples readable when narrow.
      return { label: appliedText(state.presetName, t), hint: crewRouteLines(state, t).join('\n'), retry: false }
    /* v8 ignore next 3 -- closed-union backstop; only reached if a reading is forged */
    default:
      return assertNever(state)
  }
}

/**
 * Name each role's recorded route.
 * @param state - a reading that recorded routes for every role.
 * @param t - this surface's dictionary.
 * @returns one line per role, in the formation's role order.
 */
function crewRouteLines(
  state: Extract<CrewRoutesState, { status: 'ready-with-routes' }>,
  t: TranslateNS<'settings.agentPreset'>,
): string[] {
  return state.routes.map(route => t('crewRoutesRoute', {
    role: t(ROLE_KEYS[route.role]),
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
  }))
}

/**
 * Name the recorded combination.
 * @param presetName - the name the combination carried when it was recorded.
 * @param t - this surface's dictionary.
 * @returns the header text naming the combination, with a fallback for a
 * record that lost its source name.
 */
function appliedText(
  presetName: string | null,
  t: TranslateNS<'settings.agentPreset'>,
): string {
  return t('crewRoutesApplied', { name: presetName ?? t('crewRoutesUnnamed') })
}

/**
 * Render this session's agent-preset name beside its title.
 * @param props - composed slot props.
 * @returns the label, or null when the session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, useCrewRoutes, load, loadCrewRoutes,
  loadCrewRouteCatalog, replaceCrewRole, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const options = useAgentPresets(state => state.options)
  const crew = useCrewRoutes(state => state)
  const [repairGeneration, setRepairGeneration] = useState<number>()
  const nextRepairGeneration = useRef(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
    // Only a crew session records roles, so only it is worth a formation read.
    if (preset === CREW_PRESET) void loadCrewRoutes()
  }, [preset, load, loadCrewRoutes])

  if (preset === undefined) return null

  const option = options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : presetDisplayText(option, t)

  if (preset !== CREW_PRESET) {
    const explanation = text?.description ?? t('headerHint')
    return (
      // openOnClick keeps the name and description reachable on touch devices,
      // where the native title attribute never shows and the icon-only form
      // carries no name (responsive UI: supplementary explanations tap-to-show).
      <Tooltip label={explanation} portal openOnClick side="bottom">
        {/* The narrow form hides the name, so the accessible name rides the
            label itself; tabIndex keeps the explanation reachable by focus. */}
        <span className={css.label} role="img" aria-label={text?.name ?? preset} tabIndex={0}>
          <IconAgentPresetOutlineRegular size={14} className={css.icon} />
          <span className={css.name}>{text?.name ?? preset}</span>
        </span>
      </Tooltip>
    )
  }

  const presentation = crewPresentation(crew, text?.description, t)
  // The repair action and the failed read's retry live in the chip's own menu:
  // they act on this combination, so they belong where it is named, and the
  // header row then spends no width on two text buttons.
  const entries: MenuEntry[] = []
  if (crew.status === 'ready-with-routes') {
    // One heading per role, in the formation's order: the combination name is
    // already on the trigger, so the list starts at what the trigger cannot say.
    for (const route of crew.routes) {
      entries.push({
        type: 'label',
        id: `route:${route.role}`,
        text: t('crewRoutesRoute', {
          role: t(ROLE_KEYS[route.role]),
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
        }),
      })
    }
    entries.push({ type: 'separator', id: 'repair-separator' }, {
      id: 'repair',
      label: t('crewRouteRepairAction'),
    })
  }
  if (presentation.retry) entries.push({ id: 'retry', label: t('crewRoutesRetry') })
  const actionable = entries.length > 0

  const chip = (
    <>
      <IconAgentPresetOutlineRegular size={14} className={css.icon} />
      <span className={css.name}>{presentation.label}</span>
      {actionable ? <IconChevronDownOutlineRegular size={12} className={css.chevron} /> : null}
    </>
  )

  return (
    <span className={css.row}>
      {actionable
        ? (
          <Menu
            open={open}
            onClose={() => { setOpen(false) }}
            items={entries}
            onSelect={(id) => {
              setOpen(false)
              if (id === 'repair') {
                const generation = nextRepairGeneration.current + 1
                nextRepairGeneration.current = generation
                setRepairGeneration(generation)
              } else void loadCrewRoutes()
            }}
            align="start"
            portal
            className={css.menuAnchor}
            anchor={(
              <button
                type="button"
                className={css.label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={presentation.label}
                onClick={() => { setOpen(value => !value) }}
              >
                {chip}
              </button>
            )}
          />
        )
        : (
          // No action to offer: the chip only explains, so a tooltip carries the
          // reason and a tap pins it on devices without hover.
          <Tooltip label={presentation.hint} portal openOnClick side="bottom">
            <span className={css.label} role="img" aria-label={presentation.label} tabIndex={0}>{chip}</span>
          </Tooltip>
        )}
      {repairGeneration !== undefined && crew.status === 'ready-with-routes'
        ? (
          <CrewRouteRepairDialog
            routes={crew.routes}
            onClose={() => {
              // A completion belongs to the opening that started it. It must
              // not close a dialog opened after that request's dialog closed.
              setRepairGeneration(current => current === repairGeneration ? undefined : current)
            }}
            loadCrewRouteCatalog={loadCrewRouteCatalog}
            replaceCrewRole={replaceCrewRole}
            t={t}
          />
        )
        : null}
    </span>
  )
}
