/**
 * Lifecycle-edge publication for managed subagent activations.
 *
 * Public event payloads live in `./types.ts`; the package-private observer
 * retains only the identity shared by each start/end pair.
 *
 * @module @deepseek-ai/dsh-subagent/lifecycle
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmFailure } from '@deepseek-ai/dsh-llm'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { renderThrown } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndCancelCause } from '@deepseek-ai/dsh-session'
import { SubagentRunId } from './types.ts'
import type { SubagentResult, SubagentRunEndInfo, SubagentRunInfo, TurnBudgetReport } from './types.ts'

/**
 * How one Activation's residency epoch ended, as both the terminal lifecycle
 * edge and the manager's own parent delivery report it.
 */
export interface ActivationTerminal {
  /** Why this epoch's last ordinary turn ended, or `error` when teardown failed. */
  readonly stopReason: SubagentResult['stopReason']
  /** The epoch's final assistant content, absent when it produced none or failed. */
  readonly output?: readonly ContentBlock[]
  /**
   * How the epoch's last consumed turn spent its output budget, absent when it
   * ran no turn. A delegating model cannot read the child's transcript, so a
   * child that burned its ceiling on a single reasoning block is otherwise
   * indistinguishable from one that ran out of context — and a re-delegation
   * based on the wrong diagnosis repeats the same death.
   *
   * Consumed by the parent's settlement notice, not published on the
   * `subagent/end` edge: {@link ActivationObserver.settle} forwards only the
   * stop reason and final output. A listener can already route on
   * `stopReason === 'max-tokens'`; publishing this report there would widen the
   * event for a consumer that does not exist.
   */
  readonly budget?: TurnBudgetReport
  /**
   * Failure detail for a `stopReason: 'error'` epoch — the child's own recorded
   * failure, or a cold fold of it. A parent that reads only "failed before it
   * finished" cannot tell an upstream queue rejection from an exhausted quota or
   * a broken transport, and re-delegates with the wrong constraint.
   */
  readonly diagnostic?: string
  /**
   * Who cancelled the epoch's last consumed turn, absent for any other ending.
   * Carried to the parent's settlement notice so a person who typed into the
   * child's own session is not mistaken for the delegating side's own stop.
   */
  readonly abortCause?: TurnEndCancelCause
}


/**
 * Lifecycle observer for one Activation's residency epoch, so continuable
 * children emit the same start/end pair as the managed execution. Package-private: the
 * continuation manager is the only consumer, and its call ordering is an
 * in-package contract rather than a published extension point.
 */
export interface ActivationObserver {
  /**
   * Publish the start edge once the epoch is resident.
   * @param child - the resident local Agent, or undefined for an external execution.
   */
  start(child?: Agent): void
  /**
   * Publish the terminal edge exactly once, pairing this epoch's {@link start},
   * after the disposal outcome is known. Called only for a resident epoch: a
   * failure before residency publishes no edge, because inventing one would
   * report a lifecycle the child never had.
   * @param result - the captured result, with teardown failures applied.
   */
  settle(result: SubagentResult): void
}

/**
 * Publish one lifecycle edge with per-listener exception containment. Run edges
 * carry the delegating parent that keys scoped dispatch; provider removal has no
 * parent carrier and reaches listeners unscoped.
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
 * @param carrier - resolve the scoped dispatch carrier for one delegating parent.
 * @returns the emitter both observers and the provider registry publish through.
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
 * Build the observer for one local or external activation's residency epoch. Creation failure before residency emits no lifecycle edge.
 * @param emit - the contained lifecycle emitter.
 * @param provider - the provider name recorded in the durable descriptor.
 * @param childId - the durable child session id.
 * @param parent - the exact live direct parent keying scoped dispatch.
 * @returns the observer whose edges this epoch publishes.
 */
export function createActivationObserver(
  emit: LifecycleEmitter,
  provider: string,
  childId: SessionId,
  parent: Agent,
): ActivationObserver {
  const identity = { runId: SubagentRunId(randomUUID()), provider, id: childId, local: false }
  return {
    start: (child?: Agent): void => {
      identity.local = child !== undefined
      emit('subagent/start', identity, parent)
    },
    settle: ({ stopReason, output }: SubagentResult): void => {
      emit('subagent/end', {
        ...identity,
        stopReason,
        ...output.length === 0 ? {} : { lastAssistantMessage: output },
      }, parent)
    },
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
