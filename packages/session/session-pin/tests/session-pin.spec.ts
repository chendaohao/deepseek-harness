// SessionPinService: setPin/get + the projection fold. The pin is a plain
// boolean state over an append-only event; behavior tests cover acceptance,
// fold, and the projection unit.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionPinService, { foldSessionPin } from '@deepseek-ai/dsh-session-pin'

describe('SessionPinService', () => {
  it('appends a session/pin event and folds the snapshot', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPinService)
    const session = ctx.sessions.create(SessionId('pin-accept'))

    const snapshot = ctx.sessionPin.setPin(session, true)
    expect(snapshot).toMatchObject({ pinned: true })
    expect(snapshot.eventSeq).toBeGreaterThanOrEqual(0)
    const event = session.snapshotEvents().findLast(item => item.type === 'session/pin')
    expect(event?.data).toEqual({ pinned: true })
    expect(foldSessionPin(session.snapshotEvents())?.pinned).toBe(true)

    const unpinned = ctx.sessionPin.setPin(session, false)
    expect(unpinned).toMatchObject({ pinned: false })
    expect(ctx.sessionPin.get(session)?.pinned).toBe(false)
  })

  it('rejects dead sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPinService)
    expect(() => ctx.sessionPin.setPin(Session.create(SessionId('detached')), true))
      .toThrow(/not live in this store/)
  })

  it('registers the pinned projection unit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionPinService)
    const session = ctx.sessions.create(SessionId('pin-projection'))
    ctx.sessionPin.setPin(session, true)
    const registry = ctx.get('sessionProjections')
    const snapshot = registry?.snapshot(session)
    expect(snapshot?.values.pinned).toMatchObject({ pinned: true })
    expect(typeof snapshot?.values.pinned?.pinAt).toBe('number')
  })
})
