import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

function text(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** turn/end reason kinds in commit order. */
function turnEndings(session: Session): string[] {
  return session.snapshotEvents().flatMap(event =>
    event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** Committed user/message events carrying one of the given message ids. */
function admissions(session: Session, id: string): number {
  return session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === id).length
}

describe('agent/turn-error-requeue', () => {
  it('returns a batch lost before admission and resumes it once', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-pre-step'), { provider: 'mock', model: 'mock' })
    let failures = 0
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (failures++ === 0) throw new Error('assembly exploded')
      return next()
    })

    const message = text('settle worker f1')
    agent.followup(message)
    // The failure latched one automatic resume, so no manual resend is needed.
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error', 'completed'])
    expect(admissions(agent.session, message.id)).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('does not return a batch that already reached the surface', async () => {
    const adapter = new MockAdapter([fail('upstream busy', 'SERVER')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-after-admit'), { provider: 'mock', model: 'mock' })

    const message = text('already admitted')
    agent.followup(message)
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error'])
    expect(admissions(agent.session, message.id)).toBe(1)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('leaves the inbox untouched when the user cancels', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-cancel'), { provider: 'mock', model: 'mock' })

    const message = text('cancel me')
    agent.followup(message)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('returns the batch but does not resume a deterministic rejection', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-auth'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request', () => {
      throw new LlmError('credential refused', 'AUTH')
    })

    const message = text('needs auth')
    agent.followup(message)
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error'])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(pending => pending.id)).toEqual([message.id])
    expect(admissions(agent.session, message.id)).toBe(0)
  })

  it('spends the single automatic resume even when the retry also fails', async () => {
    const adapter = new MockAdapter([fail('busy 1', 'SERVER'), fail('busy 2', 'SERVER'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-resume-once'), { provider: 'mock', model: 'mock' })
    // Queue follow-up work inside each failed request, so both failures have
    // pending input and only the resume latch decides whether a next turn opens.
    let queued = 0
    ctx.on('agent/request', async (_payload, next) => {
      queued += 1
      if (queued === 1) agent.followup(text('second'))
      if (queued === 2) agent.followup(text('third'))
      return next()
    })

    agent.followup(text('first'))
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error', 'error'])
    expect(adapter.requests).toHaveLength(2)
    // The carried resume flag stopped a third driver: 'third' stays queued.
    expect(agent.inbox.nextTurn.map(pending => pending.content[0])).toEqual([
      { type: 'text', text: 'third' },
    ])
  })

  it('resumes a stalled queue and completes', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('recovered')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-resume-success'), { provider: 'mock', model: 'mock' })
    let queued = false
    ctx.on('agent/request', async (_payload, next) => {
      if (!queued) {
        queued = true
        agent.followup(text('settlement notice'))
      }
      return next()
    })

    agent.followup(text('first'))
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error', 'completed'])
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('returns an unadmitted batch in its original order', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('requeue-order'), { provider: 'mock', model: 'mock' })
    let steered = false
    ctx.on('agent/turn-stopping', () => {
      if (steered) return
      steered = true
      agent.steer(text('settle f1'))
      agent.steer(text('settle f2'))
    })
    let requests = 0
    ctx.on('agent/request', async (_payload, next) => {
      requests += 1
      if (requests === 2) throw new LlmError('bad request', 'INVALID_REQUEST')
      return next()
    })

    agent.followup(text('go'))
    await agent.whenIdle()

    expect(turnEndings(agent.session)).toEqual(['error'])
    // One admitted message (the opening one); the steered batch was claimed
    // but never admitted, so it returns to next-turn in claim order.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(agent.inbox.nextTurn.map(pending => pending.content[0])).toEqual([
      { type: 'text', text: 'settle f1' },
      { type: 'text', text: 'settle f2' },
    ])
    expect(adapter.requests).toHaveLength(1)
  })
})
