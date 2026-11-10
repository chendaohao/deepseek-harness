/** All-human-messages model provider for `ctx.sessionTitle`. */

/* jscpd:ignore-start -- both shipped providers import the same shared packages. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
  type SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
  SessionTitleLlmConfigFields,
  type ResolvedSessionTitleLlmConfig,
  type SessionTitleLlmConfig,
  type SessionTitleLlmResponse,
} from '@deepseek-ai/dsh-session-title-llm'
/* jscpd:ignore-end */

export const name = 'session-title-all-prompts-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

/* jscpd:ignore-start -- each provider owns its title-length targets and reasoning control. */
/** Required execution controls plus this provider's title-length targets; no defaults. */
export interface Config extends SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
}

/** Loader schema for this provider's required execution controls and title-length targets. */
export const Config: z<Config> = z.object({
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

/** Validated immutable provider policy. */
interface ResolvedConfig extends ResolvedSessionTitleLlmConfig {
  readonly targetWords: number
  readonly targetCjkCharacters: number
}

/** Validate one positive title-length target. */
function assertTarget(name: 'targetWords' | 'targetCjkCharacters', value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-all-prompts-llm: ${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate the shared execution controls and this provider's title-length targets.
 * @param config - untrusted plugin configuration.
 * @returns immutable provider policy.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const { targetWords, targetCjkCharacters, ...execution } = config
  return {
    ...resolveSessionTitleLlmConfig(execution),
    targetWords: assertTarget('targetWords', targetWords),
    targetCjkCharacters: assertTarget('targetCjkCharacters', targetCjkCharacters),
  }
}

/** Select the route's least supported reasoning effort for a title call. */
const selectReasoningEffort = (model: Readonly<LlmResolvedModelInfo>): ReasoningEffortId | undefined =>
  model.reasoning?.efforts[0]?.id
/* jscpd:ignore-end */

/* jscpd:ignore-start -- independent provider strategies share only the execution module, not prompt or parsing policy. */
/** Language-aware system instruction, with stability rules when a provider title is anchored. */
function systemPrompt(config: ResolvedConfig, hasCurrentTitle: boolean): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
    ...hasCurrentTitle ? [
      'An existing title is supplied as currentTitle. If it still accurately describes the main topic or task, return it exactly unchanged.',
      'Follow-up questions, additional details within the same topic, acknowledgements such as "thanks", and requests to continue do not by themselves justify a title change.',
      'Do not reword, polish, shorten, or replace synonyms in an adequate title. Keeping its exact wording takes priority over the target length.',
      'Change the title only when the messages materially change or expand the main topic or task so that the existing title is no longer accurate.',
    ] : [],
  ].join('\n')
}

/** Frame messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[], currentTitle?: string): string {
  if (currentTitle !== undefined) {
    return `Update the session title from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`
  }
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/** Asterisk emphasis wrapping a whole line, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/** An emphasis run left dangling once a label around it is gone, such as `Title**`. */
const DANGLING_EMPHASIS = /[*_]{1,3}$/u

/**
 * A label naming the answer instead of being it, such as `生成会话标题：` or
 * `**Session title:**`. Emphasis on either side of the label belongs to the
 * label, not the title. The required colon keeps an ordinary title that
 * merely starts with 标题 intact.
 */
const TITLE_LABEL = /^(?:[*_]{1,3}\s*)?(?:(?:生成)?会话标题|标题|(?:session\s+)?title)\s*(?:[*_]{1,3})?\s*[:：]\s*(?:[*_]{1,3})?\s*/iu

/** Quotation pairs a model wraps a complete title in. */
const QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['`', '`']] as const

/** Drop one emphasis pair that wraps a whole line. */
function stripEmphasis(line: string): string {
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.['marker']
  const inner = groups?.['inner']
  return marker === undefined || inner === undefined || inner.includes(marker) ? line : inner
}

/** Drop an emphasis run with no partner left in the text. */
function stripDanglingEmphasis(line: string): string {
  const stripped = line.replace(DANGLING_EMPHASIS, '').trim()
  return stripped.length > 0 && !/[*_]/u.test(stripped) ? stripped : line
}

/** Drop one quotation pair that wraps a whole line. */
function stripQuotes(line: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (line.length <= open.length + close.length) continue
    if (!line.startsWith(open) || !line.endsWith(close)) continue
    const inner = line.slice(open.length, line.length - close.length)
    if (!inner.includes(open)) return inner.trim()
  }
  return line
}

/**
 * Take the title from model output: the answer after a reasoning tail, the
 * first non-empty line, without a label naming the answer, surrounding
 * quotation, or asterisk emphasis that wraps it. Models that disregard the
 * one-line instruction put the title first and commentary after it, prefix it
 * with `标题：`, or wrap it in quotes; the system instruction forbids all
 * three, so each is recovered here rather than stored. A line that is
 * entirely `*` emphasis loses the marker pair even when the model meant it
 * literally; the inner-marker check keeps emphasis inside a longer line.
 */
function titleFromOutput(text: string): string {
  // Some models stream their reasoning before the answer in the same block.
  const answer = text.includes('</think>') ? text.slice(text.lastIndexOf('</think>') + '</think>'.length) : text
  const line = answer.split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0) ?? ''
  const titled = line.replace(TITLE_LABEL, '').trim()
  return stripQuotes(stripEmphasis(stripDanglingEmphasis(titled)))
}

/** Reject terminal tool-call or max-token outcomes and derive one non-empty title from the text blocks. */
function titleFromResponse(response: SessionTitleLlmResponse): string {
  switch (response.finish.kind) {
    case 'stop':
      break
    case 'tool-calls':
      throw new Error('session-title-llm: title output must contain text only')
    case 'max-tokens':
      throw new Error('session-title-llm: title output reached maxOutputTokens')
    /* v8 ignore next -- closed SessionTitleLlmFinish union exhaustiveness guard */
    default: return assertNever(response.finish, 'SessionTitleLlmFinish')
  }
  if (response.blocks.some(block => block.type === 'tool-call')) {
    throw new Error('session-title-llm: title output must contain text only')
  }
  const text = response.blocks
    .filter((block): block is Extract<(typeof response.blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  const title = normalizeSessionTitle(titleFromOutput(text), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return title
}
/* jscpd:ignore-end */

/**
 * Register the all-prompts model provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const titleProvider = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'all-prompts',
    async generate(request) {
      const messageSeqs = request.messages.map(message => message.seq)
      const anchor = request.currentTitle?.source.kind === 'provider' ? request.currentTitle.title : undefined
      const response = await executeSessionTitleLlm(ctx, resolved, request, titleProvider, {
        system: systemPrompt(resolved, anchor !== undefined),
        input: frameMessages(request.messages, anchor),
        messageSeqs,
        selectReasoningEffort,
      })
      return {
        title: titleFromResponse(response),
        messageSeqs,
        model: response.model,
      }
    },
  })
}
