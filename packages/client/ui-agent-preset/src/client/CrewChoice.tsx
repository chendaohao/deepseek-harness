/**
 * The crew model-combination picker on the new-session screen.
 *
 * It renders beside the preset chip and only while that chip is staged on
 * `crew`, because a combination names the three delegation roles and no other
 * preset has them. A deployment with no stored combination renders nothing
 * here; the crew card explains the prerequisite instead of showing an empty
 * select it cannot fill.
 *
 * The list is the shared `Menu`, not a native `<select>`: a select popup is
 * drawn by the platform, so it ignores the theme tokens and opens as a light
 * system surface on the dark palette.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Stage one combination and apply it through an already-composed main Crew blank. */
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
 * @returns the labelled menu, or null while the picker does not apply.
 */
export function CrewChoice({
  useCrewChoice, useAgentPresetSeat, load, select, t,
}: CrewChoiceProps) {
  const state = useCrewChoice(snapshot => snapshot)
  // The chip's staged pick is the only thing that decides whether a
  // combination means anything here.
  const staged = useAgentPresetSeat(snapshot => snapshot.current)
  const [open, setOpen] = useState(false)

  useEffect(() => { void load() }, [load])

  if (staged !== 'crew' || state.options.length === 0) return null

  const chosen = state.options.find(option => option.id === state.selected)
  const currentName = chosen?.name ?? state.selected
  return (
    <span className={css.field}>
      <span className={css.label}>{t('crewChoiceLabel')}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={state.options.map(option => ({ id: option.id, label: option.name }))}
        selectedId={state.selected}
        onSelect={(id) => {
          setOpen(false)
          select(id)
        }}
        align="start"
        portal
        className={css.menuAnchor}
        anchor={(
          <button
            type="button"
            className={css.trigger}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('crewChoiceTriggerLabel', { name: currentName })}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className={css.triggerLabel}>{currentName}</span>
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
      {state.error === null ? null : <span className={css.error} role="alert">{state.error}</span>}
    </span>
  )
}
