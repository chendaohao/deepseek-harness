/** Host-owned default delegation child route. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentWorkerRouteConfig, {
  SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE,
} from '../src/worker-route-settings.ts'
import * as tool from '../src/index.ts'
import * as mock from './scripted-provider.ts'

/** Writable in-memory settings provider for the package integration. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const COMPOSED_ROUTE = { provider: 'alpha', model: 'composed-model', reasoningEffort: 'low' }

/** Reasoning efforts the registered `alpha` adapter advertises. */
const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

/** Mount the settings owner plus the real Agent, provider, and delegation tool. */
async function boot(config: tool.Config, onStart?: (request: SubagentStartRequest) => void): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentWorkerRouteConfig, COMPOSED_ROUTE)
  // Brings up LLM, sessions, projections, systemPrompt, tools, and the Agent registry.
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  // The route preflight resolves the child route through the live adapter, so
  // every provider these tests name must actually be registered.
  ctx.llm.registerAdapter(['alpha', 'composed'], new MockAdapter([], REASONING))
  await mock.mountScriptedProvider(ctx, {
    name: 'mock',
    ...onStart === undefined ? {} : { onStart },
  })
  await ctx.plugin(tool, config)
  return ctx
}

/** Create the Agent a delegation call runs as. */
async function createAgent(ctx: Context, id: string) {
  const handle = await ctx.agents.create({ sessionId: SessionId(id) })
  return handle.agent
}

/** Run one delegation through the real ToolRuntime pipeline. */
async function delegate(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>) {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-worker-route'),
    name: 'subagent',
    arguments: { description: 'run the task', prompt: 'do the thing', run_in_background: false },
    agent,
  })
}

describe('SubagentWorkerRouteConfig', () => {
  it('uses the composed base without a settings provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentWorkerRouteConfig, COMPOSED_ROUTE)

    expect(ctx.subagentWorkerRoute.current()).toEqual(COMPOSED_ROUTE)
    await ctx.fiber.dispose()
  })

  it('follows the validated user layer over the composed base', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentWorkerRouteConfig, COMPOSED_ROUTE)

    expect(ctx.subagentWorkerRoute.current()).toEqual(COMPOSED_ROUTE)
    await ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, { model: 'user-model' })
    expect(ctx.subagentWorkerRoute.current()).toEqual({ ...COMPOSED_ROUTE, model: 'user-model' })
    await ctx.fiber.dispose()
  })

  it('rejects an empty route field', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentWorkerRouteConfig, COMPOSED_ROUTE)

    await expect(ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, { model: '' }))
      .rejects.toThrow('$.model')
    await ctx.fiber.dispose()
  })

  it('fails loud when the tool opts in without the settings owner composed', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(tool, { provider: 'mock', workerRouteSettings: true }))
      .rejects.toThrow('workerRouteSettings')
    await ctx.fiber.dispose()
  })
})

describe('worker route settings reach the delegated child', () => {
  it('routes a child through the stored setting, not the composed config', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await boot(
      {
        provider: 'mock',
        workerRouteSettings: true,
        agentOptions: { provider: 'composed', model: 'composed-model', reasoningEffort: ReasoningEffortId('low') },
      },
      (request) => { starts.push(request) },
    )
    await ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, {
      provider: 'alpha',
      model: 'selected-model',
      reasoningEffort: 'high',
    })

    await delegate(ctx, await createAgent(ctx, 'worker-route-child'))

    expect(starts).toHaveLength(1)
    expect(starts[0]?.agentOptions).toMatchObject({
      provider: 'alpha',
      model: 'selected-model',
      reasoningEffort: 'high',
    })
    await ctx.fiber.dispose()
  })

  it('honors a settings update before the next delegation without remounting the definition', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await boot({ provider: 'mock', workerRouteSettings: true }, (request) => { starts.push(request) })
    const agent = await createAgent(ctx, 'worker-route-live')

    await delegate(ctx, agent)
    expect(starts[0]?.agentOptions).toMatchObject({ model: 'composed-model' })

    await ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, { model: 'second-model' })
    await delegate(ctx, agent)

    expect(starts).toHaveLength(2)
    expect(starts[1]?.agentOptions).toMatchObject({ model: 'second-model' })
    await ctx.fiber.dispose()
  })

  it('leaves the composed config in charge for a tool without the opt-in', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await boot(
      {
        provider: 'mock',
        agentOptions: { provider: 'composed', model: 'composed-model', reasoningEffort: ReasoningEffortId('low') },
      },
      (request) => { starts.push(request) },
    )
    await ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, { model: 'ignored-model' })

    await delegate(ctx, await createAgent(ctx, 'worker-route-optout'))

    expect(starts[0]?.agentOptions).toMatchObject({ provider: 'composed', model: 'composed-model' })
    await ctx.fiber.dispose()
  })

  it('reads the host setting from a tool row mounted in a scoped preset group', async () => {
    // The shipped arrangement: the preset owns the tool row inside an isolated
    // scope while the settings owner stays on the host plane, so the row must
    // resolve the service across that boundary.
    const starts: SubagentStartRequest[] = []
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentWorkerRouteConfig, COMPOSED_ROUTE)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    await mock.mountScriptedProvider(ctx, { name: 'mock', onStart: (request) => { starts.push(request) } })
    const preset = createScope(ctx, { preset: 'worker-route-scoped' })
    await preset.ctx.plugin({
      name: 'scoped-tool-row',
      inject: tool.inject,
      apply(groupCtx: Context) { tool.apply(groupCtx, { provider: 'mock', workerRouteSettings: true }) },
    })
    await ctx.settings.update(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE, { model: 'scoped-model' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('worker-route-scoped'),
      setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
    })

    await delegate(ctx, handle.agent)

    expect(starts[0]?.agentOptions).toMatchObject({ provider: 'alpha', model: 'scoped-model' })
    await ctx.fiber.dispose()
  })
})
