/** The read-only branch chip sitting left of the floating transcript controls while a turn runs. */
import { IconBranchOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './BranchChip.module.css'

/**
 * Name the Git branch checked out where this Session runs. Informational only:
 * nothing here is a control, so the chip never switches branches.
 * @param props.branch - branch name; the chip renders nothing without one.
 * @param props.t - the Chat locale seat, for the accessible description.
 * @returns the chip, or null when the run has no branch to show.
 */
export function BranchChip({ branch, t }: { branch: string | undefined; t: ChatViewSlotProps['t'] }) {
  if (branch === undefined) return null
  return (
    <Tooltip label={t('chat.branch', { branch })} side="top" align="end" delayMs={500} onlyWhenClipped>
      <span className={css.chip}>
        <IconBranchOutlineRegular size={12} />
        {/* One line with an ellipsis: a long branch never widens the floating row. */}
        <span className={css.name}>{branch}</span>
      </span>
    </Tooltip>
  )
}
