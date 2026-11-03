/**
 * Contained lifecycle notifications for subagents.
 *
 * The service owns scoped dispatch and listener containment; the manager
 * supplies event payloads from each activation.
 *
 * @module @deepseek-ai/dsh-subagent/lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmFailure } from '@deepseek-ai/dsh-llm'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { renderThrown } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TurnEndCancelCause } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRunEndInfo, SubagentRunInfo, TurnBudgetReport } from './types.ts'
 *
 * The service owns this closure because scoped dispatch keys its carrier by the
 * exact service instance, whose own context filter composes into the carrier;
 * a narrowed stand-in would silently change scope filtering.
 */
export type LifecycleEmitter = {
  (name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  (name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  (name: 'subagent/provider-removed', info: string): void
}

/**
 * Build the contained lifecycle emitter this seam publishes every edge through.
 * Every listener is independently contained: a synchronous throw or a rejected
 * returned promise is logged without starving peer listeners, changing the run,
 * or — for provider removal, which fires from a disposer — breaking teardown.
 * @param ctx - the service's own context, owning dispatch and the logger.
 * @param carrier - resolve the scoped dispatch carrier for one subagent tree root.
 * @returns the emitter the manager and provider registry publish through.
 */
export function createLifecycleEmitter(
  ctx: Context,
  carrier: (parent: Agent) => object,
): LifecycleEmitter {
  return (
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void => {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [carrier(parent), name, info]
    for (const callback of ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/**
 * Why this child's epoch ended, for the terminal lifecycle edge and the
 * manager's own parent delivery. The child's own log is authoritative:
 * teardown succeeding says nothing about whether the model errored, hit its
 * token ceiling, or was cancelled, so deriving the reason from disposal would
 * report failed work as completed.
 *
 * {@link foldConsumedWork} supplies both halves the raw turn sequence cannot:
 * which turn accounts for the work this epoch consumed, and whether accepted
 * work was cancelled after it without any turn opening over it. A recorded
 * failure still wins over a cancellation — stopping a child that had already
 * failed does not turn its failure into a cancellation.
 * @param events - this epoch's own event suffix.
 * @returns its terminal stop reason; `completed` only for an epoch that both
 *   closed cleanly and had nothing left to run.
 */
export function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = foldConsumedWork(events)
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // this epoch had claimed: the work was declined, not done.
    case 'blocked':
      return 'refusal'
    // A clean ending and no accounting turn at all share one rule: the epoch
    // finished what it was given unless a cancelled queue says otherwise.
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 4 -- `forked` appears only in constructor seed history, while
     * this function reads an epoch-owned suffix. `TurnEndReason` is merge-extensible,
     * so a backend-added variant cannot be listed; treating an unnameable reason as
     * success would report failed work as completed. */
    default:
      return 'error'
  }
}

/**
 * Why this child's last consumed turn failed, in the terms the parent can act on.
 *
 * A settlement notice that says only "failed before it finished" is
 * indistinguishable across an upstream queue rejection, an exhausted quota, and
 * a broken transport — and the three call for opposite recoveries: resume the
 * same child, wait, or replace the route. The child's own log already holds the
 * structured `LlmFailure`, so the parent's notice carries it too.
 *
 * Read from the same accounting turn {@link epochStopReason} reads, so a
 * failure that a later clean turn superseded is not reported.
 * @param events - this epoch's own event suffix.
 * @returns the failure detail, or `undefined` when the accounting turn did not fail.
 */
export function epochFailure(events: readonly SessionEvent[]): string | undefined {
  const { end } = foldConsumedWork(events)
  const reason = end?.data.reason
  if (reason?.kind !== 'error') return undefined
  return formatFailureDetail(reason.error)
}

/**
 * Render one structured failure as the single line a parent's notice carries.
 *
 * The routing code is included only when it distinguishes something: `UNKNOWN`
 * is the adapter's fallback for an error that carried no code, so printing it
 * would add noise beside the message it already prefixes.
 * @param failure - the recorded structured failure.
 * @returns the message, with its code and HTTP status when either is informative.
 */
export function formatFailureDetail(failure: LlmFailure): string {
  const qualifiers = [
    ...failure.code === 'UNKNOWN' ? [] : [failure.code],
    ...failure.status === undefined ? [] : [`HTTP ${String(failure.status)}`],
  ]
  return qualifiers.length === 0 ? failure.message : `${failure.message} (${qualifiers.join(', ')})`
}

/**
 * Who cancelled this child's last consumed turn.
 *
 * `aborted` alone conflates two situations a parent must handle in opposite
 * ways: a person typed into the child's own session and cancelled the work it
 * was doing (ask before resuming — they may want something else), and the
 * delegating side stopped it (resume). The cancel cause is already recorded on
 * the turn's own ending, so the notice can say which happened.
 * @param events - this epoch's own event suffix.
 * @returns the recorded cancel cause, or `undefined` for any other ending.
 */
export function epochAbortCause(events: readonly SessionEvent[]): TurnEndCancelCause | undefined {
  const { end } = foldConsumedWork(events)
  const reason = end?.data.reason
  return reason?.kind === 'aborted' ? reason.reason : undefined
}

/**
 * Last consumed turn's step, expressed in the terms a delegating model uses to
 * choose a recovery: how the turn ended, whether that step committed anything
 * visible, and how large its largest single reasoning block was. A step that
 * commits neither text nor a tool call has spent its whole ceiling on private
 * reasoning, which a longer prompt or a narrower file scope does not fix.
 * The step is read as the suffix's highest step number rather than by turn
 * number, which holds because a step counter restarts inside each turn: an
 * epoch that opened several turns still ranks every step of its last one
 * above every step of its earlier ones. A future change that lets step
 * numbers span turns would have to narrow this to `end.data.turn` first.
 * @param events - this epoch's own event suffix.
 * @returns the report, or `undefined` when the epoch ran no turn.
 */
export function lastTurnBudget(events: readonly SessionEvent[]): TurnBudgetReport | undefined {
  const { end } = foldConsumedWork(events)
  if (end === undefined) return undefined
  let last: Extract<SessionEvent, { type: 'assistant/message' | 'assistant/attempt' }> | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    if (last === undefined || event.data.step >= last.data.step) last = event
  }
  if (last === undefined) {
    return { turnEnd: end.data.reason.kind, toolCalls: 0, textChars: 0, largestReasoningChars: 0 }
  }
  let textChars = 0
  let toolCalls = 0
  let largestReasoningChars = 0
  for (const record of last.data.stream) {
    if (record.type === 'reasoning-chunks') {
      largestReasoningChars = Math.max(largestReasoningChars, record.texts.join('').length)
    } else if (record.type === 'text-chunks') {
      textChars += record.texts.join('').length
    } else if (record.type === 'tool-call-chunks') {
      toolCalls += 1
    }
  }
  return { turnEnd: end.data.reason.kind, toolCalls, textChars, largestReasoningChars }
}
