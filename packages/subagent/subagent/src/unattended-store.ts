/** Durable handoff of runtime-owned messages to a Session with no resident Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/**
 * How one attempt to hand a runtime-owned message to a Session ended.
 *
 * The two non-storing outcomes need different reactions, so the callers
 * distinguish them: nothing appended because the process has no durable store
 * at all is a deployment fact and never improves, while a destination that
 * still has a resident Session is the ordinary case where the live inbox
 * remains the only ordering owner.
 */
export type UnattendedAppendOutcome = 'stored' | 'no-durable-store' | 'resident'

/**
 * Append one runtime-owned message to a Session that has no resident Agent.
 *
 * A live Session takes the message through its own inbox instead, so this path
 * reads the whole stored log, appends the message at the next seq, flushes, and
 * releases the write handle before returning. The reader that later resumes the
 * Session sees the message as the newest entry of its transcript.
 *
 * The stored log carries an inherited prefix in its own coordinates — a seeded
 * Session's artifact holds the fork's events and its end-seed marker — so the
 * count of stored events is already the seq this message takes. A fork's
 * `inheritedEventCount` is a marker of where its own history begins, not an
 * offset to add to that count.
 *
 * @param ctx - context carrying the persistence and Session registries.
 * @param sessionId - durable destination Session.
 * @param message - runtime-owned user message to store.
 * @returns how the attempt ended; only `'stored'` means the message is durable.
 * @throws when the destination has no stored Session to append to.
 */
export async function appendUnattendedMessage(
  ctx: Context,
  sessionId: SessionId,
  message: UserMessage,
): Promise<UnattendedAppendOutcome> {
  const persistence = ctx.get('sessionPersistence')
  // Without a durable log there is nothing to hand off to; the caller decides
  // whether that is a failure of this delivery or an unconfigured deployment.
  if (persistence === undefined) return 'no-durable-store'
  // A resident Session owns the message ordering of its live inboxes, so its
  // next turn must claim the message through that inbox instead.
  if (ctx.get('sessions')?.get(sessionId) !== undefined) return 'resident'
  await using handle = await persistence.open(sessionId, 'write')
  const { events } = await handle.read()
  await handle.append([unattendedMessageEvent(SessionSeq(events.length), message)])
  await handle.flush()
  return 'stored'
}

/** Place one message at the stored log's next seq with the envelope the storage backends validate. */
function unattendedMessageEvent(
  seq: SessionSeq,
  message: UserMessage,
): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: message,
    surfaceOp: 'append',
  }
}

/** One attempt that stored nothing: the outcome, or the append's own rejection. */
export type UnattendedHandoffResult = Exclude<UnattendedAppendOutcome, 'stored'> | { readonly rejected: unknown }

/**
 * Report one handoff that stored nothing, without failing its caller. The three
 * causes need different reactions from whoever reads the log: a deployment
 * without persistence can never store anything, a destination whose Session
 * object is live holds its own log writer, and a rejected append is the
 * storage's own failure.
 * @param ctx - context whose logger receives the report.
 * @param sessionId - destination Session the append targeted.
 * @param result - why nothing was stored.
 */
export function reportUnattendedHandoff(
  ctx: Context,
  sessionId: SessionId,
  result: UnattendedHandoffResult,
): void {
  if (result === 'no-durable-store') {
    ctx.logger.warn(
      `message for "${sessionId}" was not stored because this process has no Session persistence configured`,
    )
    return
  }
  if (result === 'resident') {
    ctx.logger.warn(
      `message for "${sessionId}" was not stored because its Session is open without an Agent to deliver to`,
    )
    return
  }
  ctx.logger.warn(
    `message for "${sessionId}" could not be stored while it had no resident agent to receive it: ${errorChain(result.rejected)}`,
  )
}
