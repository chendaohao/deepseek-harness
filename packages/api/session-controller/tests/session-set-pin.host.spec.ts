/**
 * Session Controller setPin delegation through the composed SessionPinService:
 * acceptance appends a durable session/pin event and echoes its seq; a
 * deployment without the pin service maps to pin-unavailable; a non-pin
 * failure (stale session object) maps to internal. The agent factory is the
 * shared structural stub (see session-rename.host.spec.ts).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionPinService from '@deepseek-ai/dsh-session-pin'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

async function composed(withPin = true): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (withPin) await ctx.plugin(SessionPinService)
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

function liveAgent(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('sessions.setPin', () => {
  it('accepts through the composed pin service: durable event, echoed seq and state', async () => {
    const ctx = await composed()
    const source = liveAgent(ctx, 'session-pin-ok')

    const pinned = await remote(ctx).setPin(request({ sessionId: source.id, pinned: true }))
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    expect(pinned.value).toEqual({ pinned: true, seq: 0 })
    const event = source.events.findLast(item => item.type === 'session/pin')
    expect(event?.seq).toBe(pinned.value.seq)
    expect(event?.data).toEqual({ pinned: true })
    expect(ctx.sessionPin.get(source)?.pinned).toBe(true)

    const unpinned = await remote(ctx).setPin(request({ sessionId: source.id, pinned: false }))
    expect(unpinned.ok).toBe(true)
    if (!unpinned.ok) return
    expect(ctx.sessionPin.get(source)?.pinned).toBe(false)
  })

  it('maps a missing pin service to pin-unavailable with the session id', async () => {
    const ctx = await composed(false)
    const source = liveAgent(ctx, 'session-pin-no-service')

    const response = await remote(ctx).setPin(request({ sessionId: source.id, pinned: true }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/pin-unavailable',
        details: { sessionId: source.id },
      })
    }
  })

  it('maps a non-pin failure (stale session object) to internal', async () => {
    const ctx = await composed()
    const foreign = await composed(false)
    const stale = liveAgent(foreign, 'session-pin-stale')
    ctx.agents.register({ id: stale.id, session: stale, status: 'idle', ctx } as Agent)

    const response = await remote(ctx).setPin(request({ sessionId: stale.id, pinned: true }))
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('internal')
  })
})
