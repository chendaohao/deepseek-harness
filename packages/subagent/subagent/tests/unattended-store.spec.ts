/** Storing a runtime-owned message for a Session that has no resident Agent. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendUnattendedMessage } from '../src/unattended-store.ts'
import { loadStoredSession } from './persistence-helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'temp-root cleanup failed')
})

/** Mount the Session registry and a real JSONL backend over one temp root. */
async function setup() {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-unattended-store-'))
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
  const sessionsFiber = await ctx.plugin(SessionStore)
  cleanups.push(async () => {
    await sessionsFiber.dispose()
    await persistenceFiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return ctx
}

/** Author one empty stored Session at the current logical format. */
async function seedSession(ctx: Context, id: SessionId): Promise<void> {
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: '/tmp',
  })
  await handle.flush()
  await handle.close()
}

/** Author one stored Session whose log begins with a fork's inherited prefix. */
async function seedForkedSession(ctx: Context, id: SessionId, inherited: number): Promise<void> {
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: true,
    cwd: '/tmp',
  }, { inheritedEventCount: SessionLogOffset(inherited) })
  await handle.append([
    ...Array.from({ length: inherited }, (_, seq): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(seq),
      time: seq + 1,
      data: createUserMessage({ content: [{ type: 'text', text: `inherited-${String(seq)}` }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    })),
    { type: 'session/end-seed', seq: SessionSeq(inherited), time: inherited + 1, data: { inherited: true } },
  ])
  await handle.flush()
  await handle.close()
}

/** One runtime-owned user message attributed to the subagent seam. */
function runtimeMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('appendUnattendedMessage', () => {
  it('stores the message at the next seq of a Session with no resident Agent', async () => {
    const ctx = await setup()
    const id = SessionId('stored-destination')
    await seedSession(ctx, id)

    const stored = await appendUnattendedMessage(ctx, id, runtimeMessage('handed off'))
    expect(stored).toBe('stored')

    const persisted = await loadStoredSession(ctx.sessionPersistence, id)
    expect(persisted.events).toHaveLength(1)
    expect(persisted.events[0]!.type).toBe('user/message')
    expect(persisted.events[0]!.seq).toBe(0)
    expect(persisted.events[0]!.surfaceOp).toBe('append')
    expect(persisted.events[0]!.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'handed off' }],
      source: { kind: 'user' },
    })
  })

  it('appends after an already stored log instead of replacing its prefix', async () => {
    const ctx = await setup()
    const id = SessionId('appended-destination')
    await seedSession(ctx, id)
    await appendUnattendedMessage(ctx, id, runtimeMessage('first'))
    await appendUnattendedMessage(ctx, id, runtimeMessage('second'))

    const persisted = await loadStoredSession(ctx.sessionPersistence, id)
    expect(persisted.events.map(event => event.seq)).toEqual([0, 1])
    expect(persisted.events.map(event => event.type === 'user/message'
      ? event.data.content.at(0) : undefined)).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  })

  it('continues the log coordinates of a Session that inherited a fork prefix', async () => {
    const ctx = await setup()
    const id = SessionId('forked-destination')
    await seedForkedSession(ctx, id, 3)

    const stored = await appendUnattendedMessage(ctx, id, runtimeMessage('handed to a forked parent'))
    expect(stored).toBe('stored')

    const persisted = await loadStoredSession(ctx.sessionPersistence, id)
    // The inherited prefix keeps its own seqs and the end-seed marker keeps the
    // cut, so the handoff lands after both rather than overwriting either.
    expect(persisted.events.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'user/message', 'session/end-seed', 'user/message',
    ])
    expect(persisted.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(persisted.events.at(-1)!.data).toMatchObject({ content: [{ type: 'text', text: 'handed to a forked parent' }] })
  })

  it('declines to store while a Session is resident, leaving its inbox the only ordering owner', async () => {
    const ctx = await setup()
    const id = SessionId('resident-destination')
    await seedSession(ctx, id)
    ctx.sessions.enter(ctx.sessions.get(id) ?? ctx.sessions.prepare(id, {}))

    const outcome = await appendUnattendedMessage(ctx, id, runtimeMessage('not for the log'))
    expect(outcome).toBe('resident')
    await expect(loadStoredSession(ctx.sessionPersistence, id)).resolves.toMatchObject({ events: [] })
  })

  it('declines without a persistence backend instead of inventing a destination', async () => {
    const ctx = new Context()
    const outcome = await appendUnattendedMessage(ctx, SessionId('nowhere'), runtimeMessage('dropped'))
    expect(outcome).toBe('no-durable-store')
  })

  it('rejects when the destination has no stored Session', async () => {
    const ctx = await setup()
    await expect(appendUnattendedMessage(ctx, SessionId('absent'), runtimeMessage('nowhere to go')))
      .rejects.toThrow(/not found|absent/i)
  })

  it('releases the write claim so a later append can take it again', async () => {
    const ctx = await setup()
    const id = SessionId('released-destination')
    await seedSession(ctx, id)
    const open = vi.spyOn(ctx.sessionPersistence, 'open')

    await appendUnattendedMessage(ctx, id, runtimeMessage('first'))
    // A held handle would reject this second claim with SessionAlreadyOwnedError.
    await appendUnattendedMessage(ctx, id, runtimeMessage('second'))

    expect(open).toHaveBeenCalledTimes(2)
    const persisted = await loadStoredSession(ctx.sessionPersistence, id)
    expect(persisted.events).toHaveLength(2)
  })
})
