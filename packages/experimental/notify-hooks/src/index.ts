/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. Bespoke behavior should
 * use typed native plugins on the same extension points.
 * @module @deepseek-ai/dsh-notify-hooks
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hooks-claude-code': { kind: 'hooks-claude-code' } & ContextFormed
  }
}

import type { ContentBlock, FinishReason, GenerateOptions, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  mergeHookOutputs,
  runHook,
  selectHookGroups,
  type HookOutput,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'

export const name = 'notify-hooks'
// `shell` runs hooks and `sessionProjections` supplies turn numbers; the rest
// are read opportunistically via ctx.get so a deployment can omit them.
export const inject = ['shell', 'sessionProjections', 'workingDirectory']

/**
 * Model-backed turn-summary controls; the group's presence opts the feature in.
 * At `Stop` the bridge extracts the turn's human request and final assistant
 * response, generates a summary with this route, and adds it to the Stop hook
 * payload as `summary`. The Stop hooks then run detached, so sending the
 * summary never delays the turn boundary.
 */
export interface SummaryConfig {
  /** Registered LLM provider route for the summary request. */
  provider: string
  /** Model id on {@link SummaryConfig.provider}. */
  model: string
  /** System prompt for the summary request. */
  prompt?: string
  /** Output-token cap for the summary request. */
  maxTokens?: number
  /** Character cap for the extracted task/result input. */
  maxInputChars?: number
  /** End-to-end deadline for the summary request in milliseconds. */
  timeoutMs?: number
}

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's current directory (the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * Optional model-backed turn summary. Presence opts in: at `Stop` the
   * bridge generates a summary with the configured route and adds it to the
   * Stop hook payload as `summary`, then runs the Stop hooks detached so
   * sending never delays the turn boundary. A blocking Stop hook still forces
   * continuation, through a new turn.
   */
  summary?: SummaryConfig
}

/** Default system prompt for the turn-summary request. */
const DEFAULT_SUMMARY_PROMPT = 'Summarize the completed task for a push notification. State what the user asked for and what was done, in at most three sentences, in the language of the user request. Plain text only.'

/** Default output-token cap for the turn-summary request. */
const DEFAULT_SUMMARY_MAX_TOKENS = 512

/** Default character cap for the extracted task/result input. */
const DEFAULT_SUMMARY_MAX_INPUT_CHARS = 20_000

/** Default end-to-end deadline for the turn-summary request. */
const DEFAULT_SUMMARY_TIMEOUT_MS = 60_000

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  summary: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    prompt: z.string().default(DEFAULT_SUMMARY_PROMPT),
    maxTokens: z.number().default(DEFAULT_SUMMARY_MAX_TOKENS),
    maxInputChars: z.number().default(DEFAULT_SUMMARY_MAX_INPUT_CHARS),
    timeoutMs: z.number().default(DEFAULT_SUMMARY_TIMEOUT_MS),
  }).default(undefined as unknown as SummaryConfig),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'hooks-claude-code'}` producer source stamped on every context this bridge injects. The kind is a released session-format producer identity, so it stays stable while the package is renamed. */
const CONTEXT_SOURCE: MessageSource = { kind: 'hooks-claude-code' }

/** Exact model-visible request recorded before one turn-summary dispatch. */
export interface NotifyHooksSummaryRequestEventData {
  /** Turn number the summary belongs to. */
  readonly turn: number
  /** Registered provider route of the auxiliary request. */
  readonly provider: string
  /** Model id of the auxiliary request. */
  readonly model: string
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Output-token cap of the auxiliary request. */
  readonly maxTokens: number
}

/** Assembled turn-summary response recorded after the stream settles. */
export interface NotifyHooksSummaryResultEventData {
  /** Turn number the summary belongs to. */
  readonly turn: number
  /** Registered provider route that produced the summary. */
  readonly provider: string
  /** Model id that produced the summary. */
  readonly model: string
  /** Assembled summary text handed to the Stop hook payload. */
  readonly text: string
  /** Terminal finish reason of the auxiliary stream. */
  readonly finish: 'stop' | 'tool-calls' | 'max-tokens'
  /** Wall-clock duration of the auxiliary request in milliseconds. */
  readonly durationMs: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one turn-summary model request. */
    'notify-hooks/summary-request': NotifyHooksSummaryRequestEventData
    /** Log-only record of one assembled turn summary. */
    'notify-hooks/summary-result': NotifyHooksSummaryResultEventData
  }
}

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`notify-hooks: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // Parse once at load. A read or parse failure logs and registers nothing.
  let parsed: ClaudeCodeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`notify-hooks: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`notify-hooks: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  // Summary controls resolve after config parsing so a bad value fails at
  // load, not at a turn boundary. The group's presence is the opt-in.
  const summaryControls: ResolvedSummary | undefined = config.summary === undefined ? undefined : {
    provider: config.summary.provider,
    model: config.summary.model,
    prompt: config.summary.prompt ?? DEFAULT_SUMMARY_PROMPT,
    maxTokens: config.summary.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
    maxInputChars: config.summary.maxInputChars ?? DEFAULT_SUMMARY_MAX_INPUT_CHARS,
    timeoutMs: config.summary.timeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
  }
  if (summaryControls !== undefined) {
    assertPositiveInteger('summary.maxTokens', summaryControls.maxTokens)
    assertPositiveInteger('summary.maxInputChars', summaryControls.maxInputChars)
    assertPositiveInteger('summary.timeoutMs', summaryControls.timeoutMs)
    if (ctx.get('llm') === undefined) {
      ctx.logger.warn('notify-hooks: summary is configured but no llm service is registered — summaries are skipped')
    }
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  ctx.effect(() => () => detached.drain(), 'notify-hooks: drain detached hook runs')

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: Record<string, unknown>,
    opts: { agent?: Agent; turn?: number; directory?: 'committed'; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups = selectHookGroups(parsed[point], matchQuery, 'claude-code')
    if (groups.length === 0) return mergeHookOutputs([])
    const outputs: HookOutput[] = []
    const workdir = opts.agent === undefined ? undefined
      : opts.directory === 'committed' ? ctx.workingDirectory.get(opts.agent.session)
        : await ctx.workingDirectory.ensure(opts.agent, opts.signal)
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            matcher: group.matcher,
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload: { ...payload, cwd: workdir ?? process.cwd() },
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`notify-hooks: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`notify-hooks: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  // TODO(hook-continue-false): `merged.stop` is logged but needs a run-level halt mechanism.

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: CONTEXT_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`notify-hooks: SessionStart hook failed: ${String(error)}`)
      })
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn, signal })
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      ...downstream,
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step.
  // TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    if (summaryControls === undefined) {
      const merged = await runPoint('Stop', '', stopPayload(agent), { agent, turn, signal })
      if (merged.decision === 'deny') {
        // A blocking Stop hook forces continuation.
        const text = merged.reason ?? 'continue: blocked by Stop hook'
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
      }
      return
    }
    // Summary mode: the summary is generated inside the boundary — the session
    // is live and the turn's messages are complete — and the Stop hooks then
    // run detached so sending never delays the boundary.
    const summary = await generateTurnSummary(ctx, agent, turn, summaryControls,
      AbortSignal.any([detached.signal, AbortSignal.timeout(summaryControls.timeoutMs)]))
      .catch((error: unknown) => {
        ctx.logger.warn(`notify-hooks: turn summary failed: ${String(error)}`)
        return undefined
      })
    const payload = summary === undefined ? stopPayload(agent) : { ...stopPayload(agent), summary }
    detached.track(runPoint('Stop', '', payload, { agent, signal: detached.signal })
      .then((merged) => {
        if (merged.decision === 'deny') {
          const text = merged.reason ?? 'continue: blocked by Stop hook'
          agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
        }
      })
      .catch((error: unknown) => { ctx.logger.warn(`notify-hooks: Stop hook failed: ${String(error)}`) }))
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the child's directory and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload('SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`notify-hooks: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    // The end edge follows child disposal; committed Session state remains readable.
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload('SubagentStop', info, child), { ...child ? { agent: child, directory: 'committed' } : {}, signal: detached.signal })
      .catch((error: unknown) => { ctx.logger.warn(`notify-hooks: SubagentStop hook failed: ${String(error)}`) }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(ctx: Context, agent: Agent | undefined): number {
  if (!agent) return 0
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary') as TurnBoundaryProjection
  return boundary.lastTurn
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: readonly ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays empty
    // (a durable consumer gap recorded in this package's README).
    transcript_path: '',
    hook_event_name: event,
  }
}

function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
function stopPayload(agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}

/** Resolved turn-summary controls after schema defaults. */
interface ResolvedSummary {
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly maxTokens: number
  readonly maxInputChars: number
  readonly timeoutMs: number
}

/**
 * Extract the turn's human request and final assistant response from the
 * derived history and frame them for the summary request. Bridge-injected
 * user context and tool results never name the task, so only human user
 * messages count.
 * @param messages - the session's derived message history.
 * @param maxInputChars - character cap for the framed input.
 * @returns the framed input, or undefined when the turn has no request or no response.
 */
function extractTurnInput(messages: readonly Message[], maxInputChars: number): string | undefined {
  let task = ''
  let result = ''
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.source.kind !== 'user') continue
      task = blocksToText(message.content)
      result = ''
    } else if (message.role === 'assistant') {
      result = blocksToText(message.content)
    }
  }
  if (task === '' || result === '') return undefined
  const head = 'Task:\n' + task + '\n\nResult:\n'
  const budget = Math.max(0, maxInputChars - head.length)
  return head + (result.length > budget ? result.slice(0, budget) + '…' : result)
}

/**
 * Classify one terminal finish reason. Operational failures throw; every other
 * terminal kind is recorded.
 * @param finish - terminal finish reason of the assembled stream.
 * @returns the recorded finish kind.
 * @throws {Error} on a provider or abort failure.
 */
function terminalFinish(finish: FinishReason): NotifyHooksSummaryResultEventData['finish'] {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return finish.kind
    case 'error':
    case 'aborted':
      throw new Error(`notify-hooks: summary request failed: ${finish.failure.message}`)
    default:
      return assertNever(finish, 'FinishReason')
  }
}

/**
 * Generate one turn summary with the configured route, recording the exact
 * request before dispatch and the assembled response after the stream
 * settles. The session stays live for the whole call, so both events land
 * inside the turn they belong to.
 * @param ctx - context exposing the optional LLM service.
 * @param agent - the stopping agent whose session receives the log events.
 * @param turn - the turn number the summary belongs to.
 * @param controls - resolved summary controls.
 * @param signal - cancellation covering route preparation and the stream.
 * @returns the summary text, or undefined when the turn has nothing to summarize or no llm service is registered.
 */
async function generateTurnSummary(
  ctx: Context,
  agent: Agent,
  turn: number,
  controls: ResolvedSummary,
  signal: AbortSignal,
): Promise<string | undefined> {
  const input = extractTurnInput(agent.session.deriveMessages(), controls.maxInputChars)
  if (input === undefined) return undefined
  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: CONTEXT_SOURCE,
  })]
  agent.session.append('notify-hooks/summary-request', {
    turn,
    provider: controls.provider,
    model: controls.model,
    system: controls.prompt,
    messages,
    maxTokens: controls.maxTokens,
  })
  const started = performance.now()
  const call = await llm.prepareCall({
    provider: controls.provider,
    model: controls.model,
    maxTokens: controls.maxTokens,
  }, signal)
  const options: GenerateOptions = {
    ...call.config,
    messages,
    system: controls.prompt,
    sessionId: agent.session.id,
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  const finish = terminalFinish(assembler.finish)
  const text = blocksToText(assembler.blocks())
  agent.session.append('notify-hooks/summary-result', {
    turn,
    provider: controls.provider,
    model: controls.model,
    text,
    finish,
    durationMs: performance.now() - started,
  })
  return text
}
