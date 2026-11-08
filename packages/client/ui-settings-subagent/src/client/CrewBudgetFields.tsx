/** Crew per-turn budget fields inside the shared Subagent settings card. */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CrewBudgetCardFace, CrewBudgetCardState } from './crew-budget-card-controller.ts'
import css from './SubagentLimitsFields.module.css'

/** Plain state and edit callbacks supplied by the owning card. */
export type CrewBudgetFieldsProps = PropsLocale<'settings.subagent'>
  & Pick<CrewBudgetCardFace, 'edit' | 'resetField'>
  & { state: CrewBudgetCardState }

/**
 * Render all Crew turn budgets with staged validation and reset behavior.
 * @param props - Locale, staged fields, and edit callbacks.
 * @returns Four responsive fields using the existing limits grid.
 */
export function CrewBudgetFields(props: CrewBudgetFieldsProps) {
  const { t, state } = props
  const disabled = !state.writable || state.saving
  return (
    <div className={css.limits}>
      <div className={css.limit}>
        <SettingsValueField id="plugin-config-crew-budget-steps" label={t('crewBudgetMaxSteps')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('crewBudgetStepsInvalid')}
          numeric disabled={disabled} {...state.maxStepsPerTurn}
          onEdit={(text) => { props.edit('maxStepsPerTurn', text) }} onReset={() => { props.resetField('maxStepsPerTurn') }} />
      </div>
      <div className={css.limit}>
        <SettingsValueField id="plugin-config-crew-budget-wall-time" label={t('crewBudgetWallTime')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('crewBudgetWallTimeInvalid')}
          numeric disabled={disabled} {...state.maxWallTimeMsPerTurn}
          onEdit={(text) => { props.edit('maxWallTimeMsPerTurn', text) }} onReset={() => { props.resetField('maxWallTimeMsPerTurn') }} />
      </div>
      <div className={css.limit}>
        <SettingsValueField id="plugin-config-crew-budget-tokens" label={t('crewBudgetMaxTokens')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('crewBudgetTokensInvalid')}
          numeric disabled={disabled} {...state.maxTotalTokensPerTurn}
          onEdit={(text) => { props.edit('maxTotalTokensPerTurn', text) }} onReset={() => { props.resetField('maxTotalTokensPerTurn') }} />
      </div>
      <div className={css.limit}>
        <SettingsValueField id="plugin-config-crew-budget-failures" label={t('crewBudgetMaxFailures')}
          overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('crewBudgetFailuresInvalid')}
          numeric disabled={disabled} {...state.maxConsecutiveIdenticalFailures}
          onEdit={(text) => { props.edit('maxConsecutiveIdenticalFailures', text) }}
          onReset={() => { props.resetField('maxConsecutiveIdenticalFailures') }} />
      </div>
    </div>
  )
}
