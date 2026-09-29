import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as MaxTokensRecovery from '@deepseek-ai/dsh-max-tokens-recovery'
import type { Config } from '@deepseek-ai/dsh-max-tokens-recovery'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** A step that streams only reasoning and stops at the provider's token ceiling. */
function reasoningCeiling(reasoningChars: number, visibleText = ''): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (reasoningChars > 0) {
    chunks.push(
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'r'.repeat(reasoningChars) },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'r'.repeat(reasoningChars) } },
    )
  }
  if (visibleText.length > 0) {
    chunks.push(
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: visibleText },
      { type: 'block-end', index: 1, block: { type: 'text', text: visibleText } },
    )
  }
  chunks.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  return chunks
}

/** Boot the core spine plus the guard. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MaxTokensRecovery, config)
  return ctx
}

/**
 * Wait until the adapter has served `count` model calls and the agent is idle.
 * The guard queues its recovery from a session-event listener, so a single idle
 * observation can land before the queued turn exists.
 */
async function settle(agent: Agent, adapter: MockAdapter, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && adapter.requests.length < count; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  await agent.whenIdle()
}

/** Every recovery prompt in the agent's log, in order, as its source and joined text. */
function recoveries(agent: Agent): { source: unknown; text: string }[] {
  return agent.session.snapshotEvents()
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message'
      && e.data.source.kind === 'max-tokens-recovery')
    .map(event => ({
      source: event.data.source,
      text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }))
}

/** Every ordinary assistant answer the agent committed, flattened. */
function answers(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap((e) => {
    if (e.type !== 'assistant/message') return []
    return [e.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
  })
}

/** Queue one ordinary human turn. */
function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('bounded ceiling recovery', () => {
  it('queues one recovery turn when a turn burns its whole ceiling on reasoning', async () => {
    const ctx = await harness()
    // The measured failure: 122,686 characters of reasoning, no text, no tool
    // call, ceiling reached. Without the guard the session simply stops here.
    const adapter = new MockAdapter([reasoningCeiling(122_686), textResponse('recovered work')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('burn'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 2)

    const found = recoveries(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.source).toEqual({ kind: 'max-tokens-recovery' })
    const text = found[0]!.text
    expect(text).toContain('hit the output token ceiling')
    // The recovery prompt must name the real constraint rather than narrowing scope.
    expect(text).toContain('Do not restate the plan')
    expect(answers(agent)).toContain('recovered work')
  })

  it('does not recover a turn that committed visible text before the ceiling', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([reasoningCeiling(90_000, 'partial answer'), textResponse('later')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('textual'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 1)

    expect(recoveries(agent)).toHaveLength(0)
    expect(answers(agent)).toContain('partial answer')
  })

  it('does not recover an ordinary turn that simply finished', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([textResponse('done first try')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('clean'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 1)

    expect(recoveries(agent)).toHaveLength(0)
  })

  it('stops after maxRecoveries consecutive ceiling turns instead of looping', async () => {
    const ctx = await harness({ maxRecoveries: 2 })
    const adapter = new MockAdapter([
      reasoningCeiling(50_000), reasoningCeiling(50_000), reasoningCeiling(50_000),
      textResponse('never reached'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('persistent'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 3)

    // Three ceiling turns, two recoveries: the third burn is left to end.
    expect(recoveries(agent)).toHaveLength(2)
    expect(adapter.requests).toHaveLength(3)
  })

  it('is disabled by maxRecoveries 0', async () => {
    const ctx = await harness({ maxRecoveries: 0 })
    const adapter = new MockAdapter([reasoningCeiling(50_000), textResponse('later')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('disabled'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 1)

    expect(recoveries(agent)).toHaveLength(0)
  })

  it('leaves a delegated child alone, whose budget belongs to its parent', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([reasoningCeiling(50_000), textResponse('later')])
    ctx.llm.registerAdapter(['mock'], adapter)
    // A child is a session whose header names a parent session; the registry
    // records that lineage at creation, so the guard reads it from the header.
    const created = await ctx.agents.create({
      sessionId: SessionId('child'),
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd: '/tmp', parentSession: SessionId('parent'), isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    })
    const child = created.agent
    prompt(child, 'go')
    await settle(child, adapter, 1)

    expect(recoveries(child)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('recovers again after an intervening turn that produced work', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      reasoningCeiling(50_000),
      textResponse('first recovery worked'),
      reasoningCeiling(50_000),
      textResponse('second recovery worked'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('repeat'), { provider: 'mock', model: 'mock' })
    prompt(agent, 'go')
    await settle(agent, adapter, 2)
    expect(recoveries(agent)).toHaveLength(1)

    prompt(agent, 'again')
    await settle(agent, adapter, 4)
    // The successful turn reset the run, so the second burn is eligible again.
    expect(recoveries(agent)).toHaveLength(2)
    expect(answers(agent)).toEqual(expect.arrayContaining(['first recovery worked', 'second recovery worked']))
  })
})
