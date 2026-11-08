/**
 * The session header's agent-preset label.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, and a header is only worth reading after that. Offering
 * a control here would promise a switch the host refuses; naming what the
 * session runs is the honest affordance, and the choice itself lives on the
 * new-session screen ({@link AgentPresetSeat}).
 *
 * A crew session also names the model combination it recorded. That reading is
 * the session's own record, not the combination library's current template, and
 * every reading other than "recorded" says so in its own words; a failed read
 * offers the one action it can honour, reading again.
 */

import { useEffect, useRef, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
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
    case 'ready-with-routes': {
      const applied = appliedText(state.presetName, t)
      // One line per role: the bubble wraps instead of truncating, which is what
      // keeps three provider/model/effort triples readable on a narrow screen.
      const routes = state.routes.map(route => t('crewRoutesRoute', {
        role: t(ROLE_KEYS[route.role]),
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      }))
      return { label: applied, hint: [applied, ...routes].join('\n'), retry: false }
    }
    default:
      return assertNever(state)
  }
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
  return (
    <span className={css.row}>
      <Tooltip label={presentation.hint} portal openOnClick side="bottom">
        <span className={css.label} role="img" aria-label={presentation.label} tabIndex={0}>
          <IconAgentPresetOutlineRegular size={14} className={css.icon} />
          <span className={css.name}>{presentation.label}</span>
        </span>
      </Tooltip>
      {crew.status === 'ready-with-routes'
        ? (
          <button
            type="button"
            className={css.retry}
            onClick={() => {
              const generation = nextRepairGeneration.current + 1
              nextRepairGeneration.current = generation
              setRepairGeneration(generation)
            }}
          >
            {t('crewRouteRepairAction')}
          </button>
        )
        : null}
      {presentation.retry
        ? (
          <button
            type="button"
            className={css.retry}
            onClick={() => { void loadCrewRoutes() }}
          >
            {t('crewRoutesRetry')}
          </button>
        )
        : null}
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
