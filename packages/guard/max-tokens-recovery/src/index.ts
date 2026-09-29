/**
 * Recovery for a turn that spent its entire output ceiling on private
 * reasoning. A provider stops a step at its token ceiling with no text and no
 * tool call recorded; the loop ends the turn there, so the agent silently stops
 * making progress while its transcript still looks healthy. This guard queues
 * exactly one bounded recovery prompt for the next turn, once per run of
 * consecutive ceiling hits, so the model gets a chance to deliver work instead
 * of the failure passing unobserved.
 *
 * The guard is deliberately narrow: it fires only on the ceiling, only when the
 * step committed nothing visible, and only when the turn is otherwise over.
 * Configuration lives in the package README; the measured failure it answers
 * lives in the recovery Agent Note.
 * @module @deepseek-ai/dsh-max-tokens-recovery
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  assistantStreamHasVisibleText,
  createUserMessage,
  lastAssistantStreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, ContentBlock, ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import { renderThrown } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Location attribution; readers preserve the content without this producer,
     * so a build that does not know the kind still replays the recovery prompt.
     * @persistenceAttribution
     */
    'max-tokens-recovery': { kind: 'max-tokens-recovery' } & ContextFormed
  }
}

export const name = 'max-tokens-recovery'
export const inject = ['agents']

/** Plugin configuration for the bounded ceiling recovery. */
export interface Config {
  /**
   * Recovery prompts allowed per run of consecutive ceiling hits (default 1).
   * A run ends as soon as a step commits visible text or requests a tool call,
   * so an agent that recovers becomes eligible again the next time it burns its
   * ceiling. `0` disables the guard.
   */
  maxRecoveries?: number
}

export const Config: z<Config> = z.object({
  maxRecoveries: z.number().step(1).min(0).default(1),
})

/**
 * The single recovery instruction. It names the real constraint — output
 * budget, not the size of the task — so the retry does not narrow its scope
 * chasing a cause that never bit.
 */
const RECOVERY_TEXT =
  'Your previous turn hit the output token ceiling before emitting any visible text or tool call, so it '
  + 'produced nothing. Do not restate the plan or re-derive the design: make the single smallest concrete '
  + 'change or tool call that moves the work forward, and keep the explanation to one short sentence.'

/** The producer label stamped on every recovery prompt, so derived history never renders it as a user prompt. */
const RECOVERY_SOURCE: MessageSource = { kind: 'max-tokens-recovery' }

/** One agent's current run of consecutive ceiling hits. */
interface RecoveryState {
  /** Recovery prompts already queued for this run. */
  recoveries: number
}

/**
 * Whether one settled step spent its whole ceiling without committing work:
 * no visible text and no tool call, with the ceiling as its own finish reason.
 * @param stream - the step's compact model stream.
 * @returns whether this step is the failure the guard recovers from.
 */
function spentCeilingOnNothing(stream: readonly AssistantStreamRecord[]): boolean {
  if (assistantStreamHasVisibleText(stream)) return false
  if (stream.some(record => record.type === 'tool-call-chunks')) return false
  return lastAssistantStreamChunk(stream, 'finish')?.reason.kind === 'max-tokens'
}

/**
 * Install the bounded ceiling recovery.
 * @param ctx - plugin context owning the agent registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxRecoveries } = config as Required<Config>
  const states = new WeakMap<Agent, RecoveryState>()

  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    // A child's budget is its parent's to manage: a one-shot child owes its
    // parent a single result, and a continuable one reports through its
    // settlement notice. Recovering here would answer for a caller that never
    // asked, and would overwrite the stop reason that caller needs.
    if (session.header.parentSession !== undefined) return
    if (agent === undefined || agent.session !== session) return
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
    const state = states.get(agent) ?? { recoveries: 0 }
    states.set(agent, state)
    if (!spentCeilingOnNothing(event.data.stream)) {
      // Any committed work — text, a tool call, or an ordinary stop — ends the
      // run, so the next genuine burn is eligible again.
      state.recoveries = 0
      return
    }
    if (state.recoveries >= maxRecoveries) return
    state.recoveries += 1
    const content: ContentBlock[] = [{ type: 'text', text: RECOVERY_TEXT }]
    // `session/event` is delivered inside the append that publishes it, and an
    // append rejects any reentrant append — including the one a queue mutation
    // performs. Deferring past the publishing tick keeps this recovery off that
    // boundary, and the prompt is then queued as its own turn: a ceiling step
    // closes the turn it ended, so extending it is not an option.
    queueMicrotask(() => {
      try {
        agent.followup(createUserMessage({ content, source: RECOVERY_SOURCE }))
      } catch (error: unknown) {
        ctx.logger.warn(
          `max-tokens-recovery: could not queue a recovery for agent "${agent.id}": ${renderThrown(error)}`,
        )
      }
    })
  })

  ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
}
