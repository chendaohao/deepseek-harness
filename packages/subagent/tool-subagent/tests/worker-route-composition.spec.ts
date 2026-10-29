/** The real three-row composition: one registry plus worker, planner, and reviewer route rows behind the Loader. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentWorkerRouteConfig from '../src/worker-route-settings.ts'
import { SubagentRouteSettingsRegistry } from '../src/route-settings-registry.ts'
import * as tool from '../src/index.ts'
import * as mock from './scripted-provider.ts'

/** The three namespaces the web-app bundle composes, in bundle order. */
const NAMESPACES = {
  worker: 'subagent-worker-route-settings',
  planner: 'subagent-planner-route-settings',
  reviewer: 'subagent-reviewer-route-settings',
} as const

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

interface RowRoute {
  provider: string
  model: string
  reasoningEffort: string
}

/** Compose one route-settings row behind the Loader exactly as a bundle row is: its own entry id, optional service isolation. */
async function mountRouteRow(ctx: Context, namespace: string, route: RowRoute, isolate: boolean) {
  if (ctx.get('loader') === undefined) await ctx.plugin(Loader)
  ctx.loader.builtins['route-settings-row'] ??= SubagentWorkerRouteConfig
  const options = {
    id: namespace,
    name: 'cordis:route-settings-row',
    ...isolate ? { isolate: { subagentWorkerRoute: true } } : {},
    config: { namespace, ...route },
  }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  return entry
}

/** Bring up the shared host plane: registry, agent loop, providers, and delegation runtime. */
async function bootHost(onStart?: (request: SubagentStartRequest) => void) {
  const ctx = new Context()
  await ctx.plugin(SubagentRouteSettingsRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  ctx.llm.registerAdapter(['alpha', 'composed'], new MockAdapter([], REASONING))
  await mock.mountScriptedProvider(ctx, {
    name: 'mock',
    ...onStart === undefined ? {} : { onStart },
  })
  return ctx
}

/** Compose one delegation tool row behind the Loader, mirroring the bundle's tool row over its settings rows. */
async function mountDelegationRow(
  ctx: Context,
  toolName: string,
  routeSettingsNamespace: string,
  provider: string,
) {
  if (ctx.get('loader') === undefined) await ctx.plugin(Loader)
  ctx.loader.builtins['delegation-row'] ??= tool
  const options = {
    id: `tool-${toolName}`,
    name: 'cordis:delegation-row',
    config: { provider, toolName, routeSettingsNamespace },
  }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  return entry
}

/** Create the Agent a delegation call runs as. */
async function createAgent(ctx: Context, id: string) {
  const handle = await ctx.agents.create({ sessionId: SessionId(id) })
  return handle.agent
}

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** Run one delegation through the real ToolRuntime pipeline. */
async function delegate(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>, callId: string, toolName: string) {
  return await executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: toolName,
    arguments: { description: 'run the task', prompt: 'do the thing', run_in_background: false },
    agent,
  })
}

const ROUTES: Record<keyof typeof NAMESPACES, RowRoute> = {
  worker: { provider: 'alpha', model: 'worker-model', reasoningEffort: 'high' },
  planner: { provider: 'composed', model: 'planner-model', reasoningEffort: 'low' },
  reviewer: { provider: 'alpha', model: 'reviewer-model', reasoningEffort: 'low' },
}

/** Run one spawned delegation through the real ToolRuntime pipeline and return the child's SessionId. */
async function runSpawnedDelegation(ctx: Context, parent: Agent, toolName: string, callId: string): Promise<SessionId> {
  const result = await executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: toolName,
    arguments: { description: 'run the task', prompt: 'do the thing' },
    agent: parent,
  })
  if (result.isError) throw new Error(`delegation failed: ${JSON.stringify(result.error)}`)
  return (result.value as { subagentId: SessionId }).subagentId
}

describe('three route-settings rows compose with the registry', () => {
  it('mounts the registry and three isolated rows, resolving every namespace', async () => {
    const ctx = await bootHost()
    for (const [role, namespace] of Object.entries(NAMESPACES)) {
      await mountRouteRow(ctx, namespace, ROUTES[role as keyof typeof ROUTES], true)
    }

    const registry = ctx.subagentRouteSettings
    expect(registry.resolve(NAMESPACES.worker)?.current()).toEqual(ROUTES.worker)
    expect(registry.resolve(NAMESPACES.planner)?.current()).toEqual(ROUTES.planner)
    expect(registry.resolve(NAMESPACES.reviewer)?.current()).toEqual(ROUTES.reviewer)
    await ctx.fiber.dispose()
  })

  it('routes each role child from its own namespace, never another row\'s', async () => {
    const starts: SubagentStartRequest[] = []
    const ctx = await bootHost((request) => { starts.push(request) })
    for (const [role, namespace] of Object.entries(NAMESPACES)) {
      await mountRouteRow(ctx, namespace, ROUTES[role as keyof typeof ROUTES], true)
    }
    await mountDelegationRow(ctx, 'subagent', NAMESPACES.worker, 'mock')
    await mountDelegationRow(ctx, 'reviewer', NAMESPACES.reviewer, 'mock')
    // A settled child is released from the registry immediately, so the
    // durable marker itself is asserted in worker-route-state.spec and the
    // reselection suite; here the composition proof is that each delegation
    // resolved its route from ITS OWN namespace's owner, never another row's.
    const workerResult = await delegate(ctx, await createAgent(ctx, 'composition-worker'), 'call-worker', 'subagent')
    const reviewerResult = await delegate(ctx, await createAgent(ctx, 'composition-reviewer'), 'call-reviewer', 'reviewer')

    expect(workerResult.isError).toBe(false)
    expect(reviewerResult.isError).toBe(false)
    expect(starts).toHaveLength(2)
    expect(starts[0]?.agentOptions).toMatchObject(ROUTES.worker)
    expect(starts[1]?.agentOptions).toMatchObject(ROUTES.reviewer)
    await ctx.fiber.dispose()
  })

  it('marks each spawned child with its own row\'s namespace, never another role\'s', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-route-composition-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SubagentRouteSettingsRegistry)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['alpha', 'composed', 'mock'],
      new MockAdapter(Array.from({ length: 6 }, () => textResponse('done')), REASONING))
    // Two differently-named rows behind the Loader, each in its own isolate
    // realm, then one delegation tool row per role.
    await mountRouteRow(ctx, NAMESPACES.worker, ROUTES.worker, true)
    await mountRouteRow(ctx, NAMESPACES.planner, ROUTES.planner, true)
    await mountDelegationRow(ctx, 'subagent', NAMESPACES.worker, 'spawn')
    await mountDelegationRow(ctx, 'subagent-planner', NAMESPACES.planner, 'spawn')
    const { agent: parent } = await ctx.agents.create({
      sessionId: SessionId('composition-spawn-parent'),
      agentOptions: { provider: 'alpha', model: 'parent-model' },
    })

    const workerChild = await runSpawnedDelegation(ctx, parent, 'subagent', 'call-spawn-worker')
    const plannerChild = await runSpawnedDelegation(ctx, parent, 'subagent-planner', 'call-spawn-planner')
    await vi.waitFor(() => { expect(ctx.agents.get(workerChild)).toBeUndefined() }, { timeout: 10_000 })
    await vi.waitFor(() => { expect(ctx.agents.get(plannerChild)).toBeUndefined() }, { timeout: 10_000 })

    // The durable marker is what a cold resume reads, so it must name the row
    // that actually served the child — proof that two differently-named rows
    // never cross-install over the same child.
    const workerLog = await loadStoredSession(ctx.sessionPersistence, workerChild)
    const plannerLog = await loadStoredSession(ctx.sessionPersistence, plannerChild)
    expect(workerLog.events.flatMap(event =>
      event.type === 'subagent/worker-route' ? [event.data.namespace] : [])).toEqual([NAMESPACES.worker])
    expect(plannerLog.events.flatMap(event =>
      event.type === 'subagent/worker-route' ? [event.data.namespace] : [])).toEqual([NAMESPACES.planner])
    await ctx.fiber.dispose()
  }, 30_000)

  it('mounts from the module namespace a Loader import yields, not just the class', async () => {
    // Every other case mounts the Service class directly. A bundle row imports
    // the module and lets the Loader normalize it, so a module without a
    // default export resolves to "invalid plugin" and the registry never
    // publishes. Feeding the real module namespace through a builtin exercises
    // that same normalization without needing the package to be installed.
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins['route-settings-registry-module'] = await import('../src/route-settings-registry.ts')
    const entry = await ctx.loader.create({
      id: 'subagent-route-settings-registry',
      name: 'cordis:route-settings-registry-module',
    })
    await ctx.loader.resolve(entry)?.fiber?.await()
    expect(ctx.get('subagentRouteSettings')).toBeDefined()
    expect(ctx.subagentRouteSettings.resolve(NAMESPACES.worker)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails the second row loud without per-row isolation (the pre-fix composition)', async () => {
    const ctx = await bootHost()
    await mountRouteRow(ctx, NAMESPACES.worker, ROUTES.worker, false)
    // No `isolate` means all three rows provide the same `subagentWorkerRoute`
    // symbol: the loader registers the first and the second row's service
    // construction throws before its registry registration runs.
    const second = ctx.loader.create({
      id: NAMESPACES.planner,
      name: 'cordis:route-settings-row',
      config: { namespace: NAMESPACES.planner, ...ROUTES.planner },
    })
    await ctx.loader.await()
    const planner = ctx.loader.resolve(NAMESPACES.planner)
    await expect(planner?.fiber?.await()).rejects.toThrow('has been registered')
    await expect(second).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
