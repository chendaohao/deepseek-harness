/**
 * The crew model-combination picker on the new-session screen.
 *
 * It renders beside the preset chip and only while that chip is staged on
 * `crew`, because a combination names the three delegation roles and no other
 * preset has them. A deployment with no stored combination renders nothing
 * here; the crew card explains the prerequisite instead of showing an empty
 * select it cannot fill.
 */

import { useEffect } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the hero options row).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CrewChoiceState } from './crew-choice.ts'
import type { AgentPresetSeatState } from './seat-store.ts'
import css from './CrewChoice.module.css'

/** Registration-side business face for the combination picker. */
export interface CrewChoiceInjected {
  hooks: {
    /** Picker snapshot bound by the renderer as useCrewChoice. */
    crewChoice: SnapshotStore<CrewChoiceState>
    /**
     * The chip's own snapshot: whether the combination means anything here is
     * decided by the staged preset, which only the chip knows.
     */
    agentPresetSeat: SnapshotStore<AgentPresetSeatState>
  }
  /** Read the stored combinations and the staged pick. */
  load: () => Promise<void>
  /** Stage one combination for the session this flow is about to create. */
  select: (id: string) => void
}

/** Full component props. */
export type CrewChoiceProps =
  PropsRuntime<'conversation.hero.options'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<CrewChoiceInjected>

/**
 * Render the combination picker for a staged crew session.
 * @param props - composed slot props.
 * @returns the labelled select, or null while the picker does not apply.
 */
export function CrewChoice({
  useCrewChoice, useAgentPresetSeat, load, select, t,
}: CrewChoiceProps) {
  const state = useCrewChoice(snapshot => snapshot)
  // The chip's staged pick is the only thing that decides whether a
  // combination means anything here.
  const staged = useAgentPresetSeat(snapshot => snapshot.current)

  useEffect(() => { void load() }, [load])

  if (staged !== 'crew' || state.options.length === 0) return null

  return (
    <label className={css.field}>
      <span className={css.label}>{t('crewChoiceLabel')}</span>
      <select
        className={css.select}
        aria-label={t('crewChoiceLabel')}
        value={state.selected}
        onChange={(event) => { select(event.target.value) }}
      >
        {state.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      {state.error === null ? null : <span className={css.error} role="alert">{state.error}</span>}
    </label>
  )
}
