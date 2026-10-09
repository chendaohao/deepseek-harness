/**
 * Settlement reconciliation after a process restart.
 *
 * A continuable child's settlement notice is built and delivered in-process
 * when its Activation settles. When the owning process dies first — host
 * restart, crash — the child's persisted log is the only surviving account,
 * and the parent's log has no settlement notice for the lost epoch. On parent
 * resume this module's fold derives what the parent must be told, so an
 * orphaned child never reads as still-running work.
 *
 * @module @deepseek-ai/dsh-subagent/settlement-reconciliation
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from './assistant-output.ts'
import type { ActivationTerminal } from './lifecycle.ts'

/**
 * Derive the settlement account of a persisted child epoch whose owning
 * process ended without delivering one.
 *
 * Turn ordering, not wall-clock guesses, decides the account: a turn open at
 * the log's end means the process died mid-turn; inbox input inserted after
 * the last closed turn is follow-up work no turn ever claimed. Both read as
 * stopped work, never as completion.
 *
 * @param events - the child's own log suffix (inherited fork prefix excluded).
 * @returns the terminal account to deliver, or `undefined` when the suffix
 *   holds no events and therefore nothing to account for.
 */
export function coldSettlementTerminal(events: readonly SessionEvent[]): ActivationTerminal | undefined {
  if (events.length === 0) return undefined
  let open = false
  let end: SessionEvent<'turn/end'> | undefined
  let unrunInput = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = true
        break
      case 'turn/end':
        open = false
        end = event
        break
      case 'agent/inbox/spliced':
        // A claim splice (removedCount set) is the loop reading its inbox, not
        // new work; only an insertion after every closed turn is unrun input.
        if (event.data.removedCount === undefined && event.data.inserted.length > 0 && end !== undefined && !open) {
          unrunInput = true
        }
        break
      default:
        break
    }
  }
  const output = finalAssistantOutput(events)
  const suffix = output === undefined ? {} : { output }
  if (open || end === undefined || unrunInput) {
    return { stopReason: 'aborted', ...suffix }
  }
  switch (end.data.reason.kind) {
    case 'completed':
      return { stopReason: 'completed', ...suffix }
    case 'max-tokens':
      return { stopReason: 'max-tokens', ...suffix }
    case 'aborted':
    case 'interrupted':
      return { stopReason: 'aborted', ...suffix }
    case 'blocked':
      return { stopReason: 'refusal', ...suffix }
    case 'error':
      return { stopReason: 'error', ...suffix }
    /* v8 ignore next 4 -- `forked` appears only in constructor seed history, and
     * TurnEndReason is merge-extensible; an unnameable ending must not read as
     * success to a parent that never received the live account. */
    default:
      return { stopReason: 'error', ...suffix }
  }
}

/**
 * Whether the parent log already carries a settlement notice covering the
 * child's current last event.
 * @param parentEvents - the parent's own event list.
 * @param childId - durable child the notice would name.
 * @param childLastEventTime - time of the child's latest own event.
 * @returns true when a later-or-simultaneous settlement notice exists.
 */
export function settlementNoticeCovers(
  parentEvents: readonly SessionEvent[],
  childId: string,
  childLastEventTime: number,
): boolean {
  return parentEvents.some(event => event.type === 'user/message'
    && event.data.source.kind === 'subagent-settled'
    && event.data.source.senderSessionId === childId
    && event.time >= childLastEventTime)
}
