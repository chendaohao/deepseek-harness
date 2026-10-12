/**
 * Which delegated worker holds the worker-route setting, and for how long.
 *
 * The write seam's own refusal behavior belongs to `@deepseek-ai/dsh-settings`
 * (see its `configuration.spec.ts`); this covers the predicate the delegation
 * tool registers there, driven by real Agents and the real durable marker.
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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import SubagentWorkerRouteConfig, { SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE } from '../src/worker-route-settings.ts'
import { workerRouteWriteRefusal } from '../src/worker-route-guard.ts'
import * as tool from '../src/index.ts'

const PARENT = SessionId('worker-route-guard-parent')
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

/**
 * Mount the local delegation stack with two delegation rows — one that opts into
 * the worker-route setting and one that does not — over a scripted adapter whose
 * first `hang` requests never finish, so a test can hold workers mid-turn.
 * @returns the context and the parent Agent every delegation runs as.
 */
async function mountHeldStack(options: { recordRefreshes?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-route-guard-'))
  roots.push(root)
  const ctx = new Context()
  if (options.recordRefreshes !== undefined) {
    const published = options.recordRefreshes
    // The settings service's own publish semantics live in its configuration
    // spec; this stub records which namespaces the delegation tool asks it to
    // republish.
    ctx.provide('settings', {
      guard: (ns: string) => ({ dispose: () => {}, refresh: () => { published.push(ns) } }),
    } as never)
  }
  await liveConfig(ctx, SubagentWorkerRouteConfig, { provider: 'mock', model: 'model-a', reasoningEffort: 'high' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(
    ['hang', 'hang', ...Array.from({ length: 6 }, () => textResponse('done'))],
    REASONING,
  ))
  await ctx.plugin(tool, { provider: 'spawn', workerRouteSettings: true })
  await ctx.plugin(tool, { provider: 'spawn', toolName: 'subagent-plain' })
  const { agent: parent } = await ctx.agents.create({
    sessionId: PARENT,
    agentOptions: { provider: 'mock', model: 'model-a' },
  })
  return { ctx, parent }
}

/** Run one background delegation through the real tool pipeline. */
async function delegate(
  ctx: Context,
  parent: Agent,
  callId: string,
  toolName = 'subagent',
): Promise<SessionId> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: toolName,
    arguments: { description: 'run the task', prompt: 'do the thing', run_in_background: true },
    agent: parent,
  })
  if (result.isError) throw new Error(`delegation failed: ${JSON.stringify(result.content)}`)
  return (result.value as { subagentId: SessionId }).subagentId
}

/** Wait until one child Agent reports the named liveness. */
async function waitForStatus(ctx: Context, childId: SessionId, status: 'running' | 'idle' | undefined): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)?.status).toBe(status) }, { timeout: 10_000 })
}

/**
 * Cancel one worker's held turn and wait for it to settle. A continuable child
 * stops being resident once its run ends; its Session stays durable and
 * resumable, which is the state the recovery flow edits from.
 */
async function stopWorker(ctx: Context, childId: SessionId): Promise<void> {
  const child = ctx.agents.get(childId)
  if (child === undefined) throw new Error('the worker under test is no longer live')
  child.cancel({ kind: 'user' })
  await waitForStatus(ctx, childId, undefined)
}

describe('workerRouteWriteRefusal', () => {
  it('holds the route for a running worker that follows it, and frees it once that worker settles', async () => {
    const { ctx, parent } = await mountHeldStack()
    const childId = await delegate(ctx, parent, 'call-worker-route-guard')
    await waitForStatus(ctx, childId, 'running')

    // The worker is assembling a request from the current setting, so the route
    // it is about to use must not move under it.
    expect(workerRouteWriteRefusal(ctx.sessionProjections, ctx.agents.list())).toContain(String(childId))

    // Settling the worker is the recovery flow: it stays continuable but is no
    // longer in use, so the operator can change the route it will re-read.
    await stopWorker(ctx, childId)
    expect(workerRouteWriteRefusal(ctx.sessionProjections, ctx.agents.list())).toBeUndefined()
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)

  it('leaves the route free for a running worker the setting did not route', async () => {
    const { ctx, parent } = await mountHeldStack()
    const following = await delegate(ctx, parent, 'call-worker-route-guard-following')
    // A row without the opt-in records no marker, so its worker keeps the route
    // its own tool chose and a rewrite of the setting cannot reach it.
    const plain = await delegate(ctx, parent, 'call-worker-route-guard-plain', 'subagent-plain')
    await waitForStatus(ctx, following, 'running')
    await waitForStatus(ctx, plain, 'running')

    expect(workerRouteWriteRefusal(ctx.sessionProjections, ctx.agents.list())).toContain(String(following))
    await stopWorker(ctx, following)

    // Only the row that opted in holds the route; the plain worker still runs.
    await waitForStatus(ctx, plain, 'running')
    expect(workerRouteWriteRefusal(ctx.sessionProjections, ctx.agents.list())).toBeUndefined()
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)

  it('asks the settings service to republish when a following worker settles', async () => {
    const refreshes: string[] = []
    const { ctx, parent } = await mountHeldStack({ recordRefreshes: refreshes })
    const following = await delegate(ctx, parent, 'call-worker-route-publish')
    const plain = await delegate(ctx, parent, 'call-worker-route-publish-plain', 'subagent-plain')
    await waitForStatus(ctx, following, 'running')
    await waitForStatus(ctx, plain, 'running')
    const whileRunning = refreshes.length

    // Settling the marked worker flips the guard answer, and the flip is
    // published so an open settings page re-enables its controls.
    await stopWorker(ctx, following)
    expect(refreshes.length).toBeGreaterThan(whileRunning)
    expect(refreshes).toContain(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE)

    // A worker the setting never routed carries no marker, so its own settle
    // republishes nothing.
    const afterFollowingSettled = refreshes.length
    await stopWorker(ctx, plain)
    expect(refreshes).toHaveLength(afterFollowingSettled)
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT_MS)
})
