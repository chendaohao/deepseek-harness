/** Durable handoff of runtime-owned messages to a Session with no resident Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Append one runtime-owned message to a Session that has no resident Agent.
 *
 * A live Session takes the message through its own inbox instead, so this path
 * reads the whole stored log, appends the message at the next seq, flushes, and
 * releases the write handle before returning. The reader that later resumes the
 * Session sees the message as the newest entry of its transcript.
 *
 * @param ctx - context carrying the persistence and Session registries.
 * @param sessionId - durable destination Session.
 * @param message - runtime-owned user message to store.
 * @returns whether the message was appended and flushed.
 * @throws when the destination has no stored Session to append to.
 */
export async function appendUnattendedMessage(
  ctx: Context,
  sessionId: SessionId,
  message: UserMessage,
): Promise<boolean> {
  const persistence = ctx.get('sessionPersistence')
  // Without a durable log there is nothing to hand off to; the caller decides
  // whether that is a failure of this delivery or an unconfigured deployment.
  if (persistence === undefined) return false
  // A resident Session owns the message ordering of its live inboxes, so its
  // next turn must claim the message through that inbox instead.
  if (ctx.get('sessions')?.get(sessionId) !== undefined) return false
  await using handle = await persistence.open(sessionId, 'write')
  const { events } = await handle.read()
  await handle.append([unattendedMessageEvent(events, message)])
  await handle.flush()
  return true
}

/** Place one message at the stored log's next seq with the envelope the storage backends validate. */
function unattendedMessageEvent(
  events: readonly SessionEvent[],
  message: UserMessage,
): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(events.length),
    time: Date.now(),
    data: message,
    surfaceOp: 'append',
  }
}

/**
 * Report one unattended append failure without failing its caller.
 * @param ctx - context whose logger receives the report.
 * @param sessionId - destination Session the append targeted.
 * @param error - the rejected append.
 */
export function reportUnattendedAppendFailure(
  ctx: Context,
  sessionId: SessionId,
  error: unknown,
): void {
  ctx.logger.warn(
    `message for "${sessionId}" could not be stored while it had no resident agent to receive it: ${errorChain(error)}`,
  )
}
