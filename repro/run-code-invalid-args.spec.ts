/**
 * Standalone reproduction of session-8aa83ca8's recurring failure
 * (cc-switch, 2026-08-19): a model that calls `run_code` without its required
 * top-level `description` argument is rejected each time with `ToolArgsError`
 * INVALID_ARGS and the terse model-visible message
 * `Error: invalid arguments: missing required property "description"`.
 *
 * The real session repeated this loop 43 times because the model kept placing
 * `description` inside the program's inner `tools.bash(...)` call instead of on
 * the `run_code` call itself, and the rejection message never names the
 * argument root — so the model chased the wrong fix. The same provider/model
 * on a fresh run (same task, code mode) reproduced only ONE such slip and
 * self-corrected, confirming the 43x loop was instance-specific behavior, not
 * a harness defect.
 *
 * This spec is self-contained (its own scripted adapter, no package-internal
 * test helpers) so the folder stands alone. It is intentionally NOT under any
 * of the root vitest include patterns (the package/app/example test globs),
 * so `pnpm test` and CI do not collect it; run it explicitly with the
 * folder's own config:
 *
 *   pnpm vitest run --config repro/vitest.config.ts repro/run-code-invalid-args.spec.ts
 *
 * The positive control proves a call WITH `description` executes, isolating
 * the failure to the missing argument.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/** One tool-call stream (no leading text), mirroring the agent-loop mock adapter. */
function toolCallStream(callId: string, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(callId), name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: CallId(callId), argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(callId), name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A plain text completion stream that ends the turn. */
function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted LLM adapter: each stream() call consumes the next entry. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Scriptable in-repo CodeRuntime; validation failures never reach run(). */
class FakeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] })
  }
}

async function harness(adapter: ScriptedAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime, { mode: 'code' })
  await ctx.plugin(FakeRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

/** All text blocks under one tool result's message content, flattened. */
function resultTexts(event: SessionEvent): string[] {
  const data = event.data as { message?: { content?: unknown[] } }
  const texts: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node !== null && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (obj.type === 'text' && typeof obj.text === 'string') texts.push(obj.text)
      Object.values(obj).forEach(walk)
    }
  }
  walk(data.message?.content)
  return texts
}

describe('repro: run_code missing top-level description', () => {
  it('a model that keeps omitting `description` gets the same INVALID_ARGS rejection every time', async () => {
    const adapter = new ScriptedAdapter([
      toolCallStream('c1', RUN_CODE_NAME, { code: 'program 1' }),
      toolCallStream('c2', RUN_CODE_NAME, { code: 'program 2' }),
      toolCallStream('c3', RUN_CODE_NAME, { code: 'program 3' }),
      textStream('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const results = events(agent).filter(e => e.type === 'tool/result')
    const invalid = results.filter(e => (e.data as { error?: { code?: string } }).error?.code === 'INVALID_ARGS')
    expect(invalid).toHaveLength(3)

    for (const e of invalid) {
      const text = resultTexts(e).join(' ')
      // The exact model-visible string from the real session.
      expect(text).toContain('Error: invalid arguments: missing required property "description"')
    }
  })

  it('positive control: run_code WITH description executes and completes', async () => {
    const adapter = new ScriptedAdapter([
      toolCallStream('c1', RUN_CODE_NAME, { code: 'return 1;', description: 'A proper call' }),
      textStream('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const results = events(agent).filter(e => e.type === 'tool/result')
    expect(results).toHaveLength(1)
    const text = resultTexts(results[0]!).join(' ')
    expect(text).toContain('(run_code completed with no output)')
    expect(results[0]!.data).not.toMatchObject({ error: { code: 'INVALID_ARGS' } })
  })
})
