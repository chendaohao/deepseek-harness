/**
 * The crew session's own route set: the projection that records it, and the
 * fleet-level fact that a session's pick outranks the deployment's role
 * namespaces while an unpinned session keeps reading them.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  CREW_ROLES,
  crewRoutesOf,
  crewRoutesProjectionDefinition,
  recordCrewRoutes,
  replaceCrewRoleRoute,
  type CrewRole,
} from '../src/routes.ts'

/** One complete route set, used as the recorded and the replacement value. */
const ROUTES = {
  worker: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  planner: { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'high' },
  reviewer: { provider: 'workbuddy', model: 'kimi-k3.1-pro', reasoningEffort: 'high' },
} as const

const SELECTION = { presetId: 'preset-1', presetName: 'Deep review', routes: ROUTES }

describe('crew formation routes', () => {
  it('keeps the runtime role order aligned with the client-safe role union', () => {
    expect(CREW_ROLES).toEqual(['worker', 'planner', 'reviewer'])
    expectTypeOf<(typeof CREW_ROLES)[number]>().toEqualTypeOf<CrewRole>()
  })
  it('rejects a durable route set that omits the reviewer role', () => {
    const missingReviewer = {
      presetId: 'preset-1',
      presetName: 'Deep review',
      routes: { worker: ROUTES.worker, planner: ROUTES.planner },
      replaced: [],
      firstTurnStarted: false,
    }
    expect(() => crewRoutesProjectionDefinition.stateSchema.parse(missingReviewer)).toThrow(/reviewer/)
  })

  it('records one complete set and reads every role back', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-set'))

    expect(crewRoutesOf(handle, session).routes).toBeNull()
    recordCrewRoutes(session, SELECTION)

    const state = crewRoutesOf(handle, session)
    expect(state.presetId).toBe('preset-1')
    expect(state.presetName).toBe('Deep review')
    expect(state.routes).toEqual(ROUTES)
    expect(state.replaced).toEqual([])
    await ctx.fiber.dispose()
  })

  it('accepts a second set before the first turn and keeps the later combination', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-second-set'))

    recordCrewRoutes(session, SELECTION)
    const moved = {
      presetId: 'preset-2',
      presetName: 'Fast',
      routes: { ...ROUTES, worker: { provider: 'other', model: 'cheap', reasoningEffort: 'low' } },
    }
    recordCrewRoutes(session, moved)

    const state = crewRoutesOf(handle, session)
    expect(state.presetId).toBe('preset-2')
    expect(state.presetName).toBe('Fast')
    expect(state.routes?.worker.model).toBe('cheap')
    expect(state.replaced).toEqual([])
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('keeps the first set once a turn started, so a running turn holds its delegation targets', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-set-after-turn'))

    recordCrewRoutes(session, SELECTION)
    session.append('turn/start', { turn: 1 })
    const moved = {
      presetId: 'preset-2',
      presetName: 'Fast',
      routes: { ...ROUTES, worker: { provider: 'other', model: 'cheap', reasoningEffort: 'low' } },
    }
    recordCrewRoutes(session, moved)

    const state = crewRoutesOf(handle, session)
    expect(state.presetId).toBe('preset-1')
    expect(state.routes?.worker.model).toBe('deepseek-v4.1-flash')
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('still accepts a first set appended after a turn started', async () => {
    // A resumed session that never recorded a combination: its first pick is
    // the set it runs, so the later suppression only protects a recorded set.
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-set-late'))

    session.append('turn/start', { turn: 1 })
    recordCrewRoutes(session, SELECTION)

    expect(crewRoutesOf(handle, session).presetId).toBe('preset-1')
    await ctx.fiber.dispose()
  })

  it('marks the first turn once, keeping the state reference for later turns', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-turn-once'))

    session.append('turn/start', { turn: 1 })
    const started = crewRoutesOf(handle, session)
    expect(started.firstTurnStarted).toBe(true)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    expect(crewRoutesOf(handle, session)).toBe(started)
    await ctx.fiber.dispose()
  })

  it('replays the same state on a cold resume, and a resumed pick is still fixed', async () => {
    // The fold reads only `turn/start` and the two crew events, so replaying the
    // stored log reproduces the live state without the combination library.
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-resume'))

    recordCrewRoutes(session, SELECTION)
    recordCrewRoutes(session, { presetId: 'preset-2', presetName: 'Fast', routes: { ...ROUTES, worker: { provider: 'other', model: 'cheap', reasoningEffort: 'low' } } })
    session.append('turn/start', { turn: 1 })

    const online = crewRoutesOf(handle, session)
    const resumed = Session.create(SessionId('formation-resume'), session.snapshotEvents())
    expect(crewRoutesOf(handle, resumed)).toEqual(online)
    expect(crewRoutesOf(handle, resumed).firstTurnStarted).toBe(true)
    // The resumed session opened its first turn, so the fold keeps the record.
    recordCrewRoutes(resumed, SELECTION)
    expect(crewRoutesOf(handle, resumed).presetId).toBe('preset-2')
    await ctx.fiber.dispose()
  })

  it('replaces one role without touching the other two and stops naming the combination', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-replace'))
    recordCrewRoutes(session, SELECTION)

    replaceCrewRoleRoute(session, 'worker', { provider: 'backup', model: 'spare-model', reasoningEffort: 'high' })

    const state = crewRoutesOf(handle, session)
    expect(state.routes?.worker).toEqual({ provider: 'backup', model: 'spare-model', reasoningEffort: 'high' })
    expect(state.routes?.planner).toEqual(ROUTES.planner)
    expect(state.routes?.reviewer).toEqual(ROUTES.reviewer)
    // A role no longer matches the named combination, so the session stops
    // claiming one while keeping the name it started from.
    expect(state.presetId).toBeNull()
    expect(state.presetName).toBe('Deep review')
    expect(state.replaced).toEqual(['worker'])
    await ctx.fiber.dispose()
  })

  it('keeps one entry per role however many times that role is replaced', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-replace-twice'))
    recordCrewRoutes(session, SELECTION)

    replaceCrewRoleRoute(session, 'reviewer', { provider: 'a', model: 'm', reasoningEffort: 'low' })
    replaceCrewRoleRoute(session, 'reviewer', { provider: 'b', model: 'n', reasoningEffort: 'high' })

    const state = crewRoutesOf(handle, session)
    expect(state.replaced).toEqual(['reviewer'])
    expect(state.routes?.reviewer.provider).toBe('b')
    await ctx.fiber.dispose()
  })

  it('ignores a replacement for a session that recorded no set', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const handle = await ctx.sessionProjections.register(crewRoutesProjectionDefinition)
    const session = Session.create(SessionId('formation-unset'))

    // A replacement with nothing to replace would otherwise claim a formation
    // this session never picked.
    replaceCrewRoleRoute(session, 'worker', { provider: 'a', model: 'm', reasoningEffort: 'low' })

    expect(crewRoutesOf(handle, session).routes).toBeNull()
    await ctx.fiber.dispose()
  })
})
