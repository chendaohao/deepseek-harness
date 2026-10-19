/**
 * Worker-route children re-resolve their LLM route from the Host setting on
 * every later activation instead of the route baked at creation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { TestSessionQuery } from '../../subagent/tests/test-session-query.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import SubagentWorkerRouteConfig from '../src/worker-route-settings.ts'
import * as tool from '../src/index.ts'

const PARENT = SessionId('worker-route-parent')
const TEST_TIMEOUT_MS = 30_000
const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

/** One process lifetime over a persistence root that outlives a restart. */
interface Stack {
  ctx: Context
  adapter: MockAdapter
  live: Awaited<ReturnType<typeof liveConfig>>
}

/**
 * Mount the local delegation stack over one persistence root. The caller owns
 * the parent Agent, so a restarted process resumes the same durable one.
 * @param root - persistence root shared across process lifetimes.
 * @param route - the stored worker route this process starts with.
 * @param withModelSelection - also expose model-facing route selection.
 * @returns the context, the scripted adapter, and the editable setting.
 */
async function mountStack(
  root: string,
  route: { provider: string; model: string; reasoningEffort: string },
  withModelSelection = false,
): Promise<Stack> {
  const ctx = new Context()
  const live = await liveConfig(ctx, SubagentWorkerRouteConfig, route)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  if (withModelSelection) {
    await ctx.plugin(SubagentModelSelectionConfig, {
      enabled: true,
      allowedModels: [{ provider: 'alpha', model: 'selected-model' }],
    })
  }
  const adapter = new MockAdapter(Array.from({ length: 6 }, () => textResponse('done')), REASONING)
  ctx.llm.registerAdapter(['mock', 'alpha'], adapter)
  return { ctx, adapter, live }
}

/**
 * Install the delegation tool; model selection installs per Session, so that
 * mode needs the parent whose scope receives it.
 */
async function installTool(ctx: Context, parent?: Agent, withModelSelection = false): Promise<void> {
  if (!withModelSelection) {
    await ctx.plugin(tool, { provider: 'spawn', workerRouteSettings: true })
    return
  }
  if (parent === undefined) throw new Error('model-selection installation requires its parent Agent')
  const fiber = parent.ctx.inject(tool.inject, (runtimeCtx) => {
    tool.apply(runtimeCtx, { provider: 'spawn', workerRouteSettings: true, modelSelectionSettings: true }, parent.session)
  })
  await fiber.await()
}

/** Create the durable parent both a first run and a restart resume. */
async function createParent(ctx: Context): Promise<Agent> {
  const { agent } = await ctx.agents.create({
    sessionId: PARENT,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return agent
}

/** Run one delegation through the real ToolRuntime pipeline. */
async function delegate(
  ctx: Context,
  parent: Agent,
  args: Record<string, unknown> = {},
): Promise<SessionId> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-worker-route-reselection'),
    name: 'subagent',
    arguments: { description: 'run the task', prompt: 'do the thing', ...args },
    agent: parent,
  })
  if (result.isError) throw new Error(`delegation failed: ${JSON.stringify(result.value)}`)
  return (result.value as { subagentId: SessionId }).subagentId
}

/** Requests the scripted adapter served for one exact Session, in order. */
function requestsFor(adapter: MockAdapter, sessionId: SessionId) {
  return adapter.requests.filter(request => request.sessionId === sessionId)
}

/**
 * Continue one child and wait for its next request and settlement. The parent
 * also runs a turn for the child's completion notice, so every assertion reads
 * the child's own requests rather than the adapter's complete history.
 */
async function continueChild(ctx: Context, parent: Agent, childId: SessionId, adapter: MockAdapter): Promise<void> {
  const before = requestsFor(adapter, childId).length
  await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: 'carry on' }], {
    signal: new AbortController().signal,
  })
  await vi.waitFor(() => { expect(requestsFor(adapter, childId).length).toBe(before + 1) }, { timeout: 10_000 })
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 10_000 })
}

describe('worker-route re-resolution', () => {
  it('marks the live child and re-routes its next turn after the setting changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-route-reselection-'))
    roots.push(root)
    const { ctx, adapter, live } = await mountStack(root, { provider: 'mock', model: 'model-a', reasoningEffort: 'high' })
    await installTool(ctx)
    const parent = await createParent(ctx)
    const childId = await delegate(ctx, parent)
    // The live install is only half the contract: the marker it appends is what
    // a later activation reads after this Agent is gone.
    await vi.waitFor(async () => {
      const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
      expect(loaded.events.some(event => event.type === 'subagent/worker-route')).toBe(true)
    }, { timeout: 10_000 })
    expect(requestsFor(adapter, childId)[0]?.model).toBe('model-a')

    await live.update({ model: 'model-b' })
    await continueChild(ctx, parent, childId, adapter)

    expect(requestsFor(adapter, childId)[1]?.model).toBe('model-b')
    expect(requestsFor(adapter, childId)[1]?.reasoningEffort).toBe('high')
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(loaded.events.flatMap(event =>
      event.type === 'request/header' ? [event.data.header.config.model] : [])).toEqual(['model-a', 'model-b'])
    // Exactly one installation owns the notice: a second one would append it twice.
    const notices = loaded.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'model-selection')
    expect(notices).toHaveLength(1)
    const noticeText = notices[0]?.type === 'user/message'
      ? notices[0].data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      : ''
    expect(noticeText).toContain('generated by model-a')
    expect(noticeText).toContain('the session continues with model-b')
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)

  it('re-resolves from the durable marker after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-route-restart-'))
    roots.push(root)
    const first = await mountStack(root, { provider: 'mock', model: 'model-a', reasoningEffort: 'high' })
    await installTool(first.ctx)
    const parent = await createParent(first.ctx)
    const childId = await delegate(first.ctx, parent)
    await vi.waitFor(() => { expect(first.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 10_000 })
    await first.ctx.fiber.dispose()

    // A second process over the same store: the child Agent is re-created from
    // its log, and only the marker can select the installation.
    const second = await mountStack(root, { provider: 'mock', model: 'model-c', reasoningEffort: 'low' })
    await installTool(second.ctx)
    const { agent: resumedParent } = await second.ctx.agents.resume({
      resumeSessionId: PARENT,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await continueChild(second.ctx, resumedParent, childId, second.adapter)

    expect(requestsFor(second.adapter, childId)[0]?.model).toBe('model-c')
    const loaded = await loadStoredSession(second.ctx.sessionPersistence, childId)
    const headers = loaded.events.filter(event => event.type === 'request/header')
    expect(headers.at(-1)?.data.header.config.model).toBe('model-c')
    await second.ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)

  it('keeps the route an explicit per-call selection named', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-route-explicit-'))
    roots.push(root)
    const { ctx, adapter, live } = await mountStack(
      root,
      { provider: 'mock', model: 'model-a', reasoningEffort: 'high' },
      true,
    )
    const parent = await createParent(ctx)
    await installTool(ctx, parent, true)
    const childId = await delegate(ctx, parent, { provider: 'alpha', model: 'selected-model' })
    expect(requestsFor(adapter, childId)[0]?.provider).toBe('alpha')
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(loaded.events.some(event => event.type === 'subagent/worker-route')).toBe(false)

    await live.update({ model: 'model-b' })
    await continueChild(ctx, parent, childId, adapter)

    expect(requestsFor(adapter, childId)[1]?.provider).toBe('alpha')
    expect(requestsFor(adapter, childId)[1]?.model).toBe('selected-model')
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)

  it('installs the re-resolution once when two opted-in rows resume the same child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worker-route-two-rows-'))
    roots.push(root)
    const { ctx, adapter, live } = await mountStack(root, { provider: 'mock', model: 'model-a', reasoningEffort: 'high' })
    await ctx.plugin(tool, { provider: 'spawn', workerRouteSettings: true })
    await ctx.plugin(tool, { provider: 'spawn', workerRouteSettings: true, toolName: 'subagent-second' })
    const parent = await createParent(ctx)
    const childId = await delegate(ctx, parent)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 10_000 })

    // The resume announces the re-created child to BOTH rows' listeners, but
    // only one installation may own the model-change notice.
    await live.update({ model: 'model-b' })
    await continueChild(ctx, parent, childId, adapter)

    expect(requestsFor(adapter, childId).at(-1)?.model).toBe('model-b')
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    const notices = loaded.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'model-selection')
    expect(notices).toHaveLength(1)
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)
})
