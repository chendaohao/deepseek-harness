import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CrewRunBudget, type CrewRunBudgetConfig } from '../src/run-budget.ts'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
}

async function harness(
  config: CrewRunBudgetConfig | (() => CrewRunBudgetConfig) = {},
  agentPreset = 'crew-worker',
): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const budget = new CrewRunBudget(ctx, config)
  budget.start()
  const id = SessionId(`budget-${Math.random()}`)
  const handle = await ctx.agents.create({
    sessionId: id,
    agentOptions: { provider: 'test', model: 'test' },
    meta: { agentPreset },
  })
  const agent = handle.agent
  return { ctx, agent, session: agent.session }
}

async function preStep(test: Harness, turn: number, step: number): Promise<PreStepDecision> {
  return test.ctx.waterfall('agent/pre-step', {
    agent: test.agent,
    messages: [],
    turn,
    step,
    signal: new AbortController().signal,
    modelSelection: { provider: 'test', model: 'test' },
  }, async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }))
}

function stops(test: Harness) {
  return test.session.snapshotEvents().filter(event => event.type === 'crew/run-budget-exceeded')
}

describe('CrewRunBudget', () => {
  it('rejects the request after the step budget and resets for a new turn', async () => {
    const test = await harness({ maxStepsPerTurn: 2 })
    await expect(preStep(test, 1, 1)).resolves.toMatchObject({ kind: 'enter' })
    await expect(preStep(test, 1, 2)).resolves.toMatchObject({ kind: 'enter' })
    await expect(preStep(test, 1, 3)).resolves.toEqual({ kind: 'reject' })
    expect(stops(test)).toMatchObject([{ data: { turn: 1, reason: 'steps', limit: 2, observed: 2 } }])
    await expect(preStep(test, 2, 1)).resolves.toMatchObject({ kind: 'enter' })
  })

  it('blocks a real agent loop before it exceeds the step budget', async () => {
    const test = await harness({ maxStepsPerTurn: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'probe', {}),
      toolCallResponse('call-2', 'probe', {}),
      textResponse('must not be requested'),
    ])
    test.ctx.llm.registerAdapter(['test'], adapter)
    test.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'probe', parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await test.agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(test.session.snapshotEvents().filter(event => event.type === 'turn/end'))
      .toMatchObject([{ data: { reason: { kind: 'blocked' } } }])
    expect(stops(test)).toMatchObject([{ data: { reason: 'steps', limit: 2, observed: 2 } }])
  })

  it('rejects the next request when this turn reaches its token budget', async () => {
    const test = await harness({ maxTotalTokensPerTurn: 50 })
    await preStep(test, 1, 1)
    test.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant', content: [], id: MessageId('usage-1'),
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
      usage: { inputTokens: 30, outputTokens: 10, totalTokens: 50, cacheReadTokens: 10 },
      stream: [],
    }, { surfaceOp: 'append' })
    await expect(preStep(test, 1, 2)).resolves.toEqual({ kind: 'reject' })
    expect(stops(test)).toMatchObject([{ data: { reason: 'tokens', limit: 50, observed: 50 } }])
  })

  it('stops a repeated structured failure and resets the chain after a different result', async () => {
    const test = await harness({ maxConsecutiveIdenticalFailures: 2 })
    await preStep(test, 1, 1)
    const exec = { agent: test.agent } as ToolExecution
    const failure: ToolExecutionResult = {
      isError: true,
      content: [],
      error: { message: 'same failure', info: { name: 'TestError', code: 'TEST' } },
    }
    const post = async (result: ToolExecutionResult) => test.ctx.waterfall(
      'tools/post-execute', exec, result,
      async (): Promise<PostToolDecision> => ({ kind: 'accept' }),
    )
    await post(failure)
    await post({ isError: false, content: [], value: null })
    await post(failure)
    await expect(preStep(test, 1, 2)).resolves.toMatchObject({ kind: 'enter' })
    await post(failure)
    await post(failure)
    await expect(preStep(test, 1, 3)).resolves.toEqual({ kind: 'reject' })
    expect(stops(test)).toMatchObject([{ data: { reason: 'repeated-failure', limit: 2, observed: 2 } }])
  })

  it('cancels active work when the wall-time budget expires', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const test = await harness({ maxWallTimeMsPerTurn: 20 })
    const cancel = vi.spyOn(test.agent, 'cancel')
    await preStep(test, 1, 1)
    await vi.advanceTimersByTimeAsync(20)
    expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'crew/run-budget-duration' })
    expect(stops(test)).toMatchObject([{ data: { reason: 'duration', limit: 20, observed: 20 } }])
  })

  it('keeps the current turn fixed and samples live limits for the next turn', async () => {
    let maxStepsPerTurn = 1
    const test = await harness(() => ({ maxStepsPerTurn }))
    await expect(preStep(test, 1, 1)).resolves.toMatchObject({ kind: 'enter' })
    maxStepsPerTurn = 2
    await expect(preStep(test, 1, 2)).resolves.toEqual({ kind: 'reject' })
    expect(stops(test)).toMatchObject([{ data: { turn: 1, reason: 'steps', limit: 1, observed: 1 } }])
    await expect(preStep(test, 2, 2)).resolves.toMatchObject({ kind: 'enter' })
  })

  it('does not intercept non-Crew agents', async () => {
    const test = await harness({ maxStepsPerTurn: 1 }, 'standard')
    await expect(preStep(test, 1, 2)).resolves.toMatchObject({ kind: 'enter' })
    expect(stops(test)).toEqual([])
  })

  it('fails configuration validation before any listener runs', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    expect(() => new CrewRunBudget(ctx, { maxStepsPerTurn: 0 })).toThrow()
  })
})
