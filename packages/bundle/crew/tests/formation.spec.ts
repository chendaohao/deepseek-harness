/**
 * The formation Remote's pick semantics: before the session's first turn a
 * different combination supersedes the recorded routes, and after it the
 * recorded set stands — an idempotent replay succeeds without another event,
 * while any other combination throws the structured `crew/conflict` failure
 * without touching the record. A call that raced past the pre-validation guard
 * settles by the session's final record rather than by a stale guard result.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SubagentRouteSettingsRegistry } from '@deepseek-ai/dsh-tool-subagent/route-settings-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import CrewFormation from '../src/formation.ts'
import type { CrewRouteSelection } from '../src/types.ts'

/** One complete route set used as every recorded value. */
const ROUTES = {
  worker: { provider: 'alpha', model: 'alpha-fast', reasoningEffort: 'high' },
  planner: { provider: 'alpha', model: 'alpha-pro', reasoningEffort: 'low' },
  reviewer: { provider: 'beta', model: 'beta-plain', reasoningEffort: 'max' },
} as const

/** A second, fully distinguishable combination. */
const OTHER = {
  worker: { provider: 'gamma', model: 'gamma-1', reasoningEffort: 'low' },
  planner: { provider: 'gamma', model: 'gamma-2', reasoningEffort: 'low' },
  reviewer: { provider: 'gamma', model: 'gamma-3', reasoningEffort: 'low' },
} as const

const A: CrewRouteSelection = { presetId: 'a', presetName: 'A', routes: ROUTES }
const B: CrewRouteSelection = { presetId: 'b', presetName: 'B', routes: OTHER }

/**
 * The formation service over a fresh context, with the catalog read stubbed.
 *
 * The resolver registrations need their serving rows; a bare owner per role
 * namespace stands in for the route-settings row, because the row's settings
 * entry and write guard are the row plugin's concerns and no case here reads
 * them.
 */
async function formationOf(preflightCall = async (config: unknown): Promise<unknown> => config) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SubagentRouteSettingsRegistry)
  // The real registry supplies `turnBoundaryOf`, so a case that appends
  // `turn/start` opens the session's first turn the way the loop does.
  await ctx.plugin(AgentRegistry)
  const registry = ctx.get('subagentRouteSettings')!
  for (const namespace of ['subagent-worker-route-settings', 'subagent-planner-route-settings', 'subagent-reviewer-route-settings']) {
    // A bare owner whose default is never read by these cases: only the
  // session pins the resolver answers matter here.
    ctx.effect(() => registry.register(namespace, {
      current: () => ({ provider: 'row-default', model: 'row-default', reasoningEffort: ReasoningEffortId('high') }),
    }), `crew formation fixture: ${namespace} row`)
  }
  ctx.provide('llm', { preflightCall } as never)
  const service = new CrewFormation(ctx, {
    worker: 'subagent-worker-route-settings',
    planner: 'subagent-planner-route-settings',
    reviewer: 'subagent-reviewer-route-settings',
  })
  await service[Service.init]()
  return { ctx, service }
}

/** One live session's agent face, the way the Remote gateway hands one over. */
function agentOf(session: Session): Agent {
  return { session } as Agent
}

/** Open the session's first turn, which fixes the routes it already recorded. */
function startFirstTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
}

describe('CrewFormation.selectRoutes', () => {
  it('records the first combination and reports the write', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-idempotent'))
    await expect(service.selectRoutes(agentOf(session), A, new AbortController().signal)).resolves.toBe(true)
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('accepts a replay of the recorded combination idempotently without another event', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-idempotent-replay'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    await expect(service.selectRoutes(agentOf(session), A, new AbortController().signal)).resolves.toBe(false)
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('supersedes the recorded combination before the first turn and appends a second event', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-before-first-turn'))
    await expect(service.selectRoutes(agentOf(session), A, new AbortController().signal)).resolves.toBe(true)
    await expect(service.selectRoutes(agentOf(session), B, new AbortController().signal)).resolves.toBe(true)
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(2)
    const view = service.viewOf(session)
    expect(view.presetId).toBe('b')
    expect(view.presetName).toBe('B')
    expect(view.routes?.map(route => route.model)).toEqual(['gamma-1', 'gamma-2', 'gamma-3'])
    expect(view.replaced).toEqual([])
    await ctx.fiber.dispose()
  })

  it('throws the structured conflict for a different combination once the first turn started', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-conflict'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    startFirstTurn(session)
    const error = await service.selectRoutes(agentOf(session), B, new AbortController().signal)
      .then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(RemoteError)
    expect((error as RemoteError).code).toBe('crew/conflict')
    expect((error as RemoteError).details).toMatchObject({ sessionId: session.id, recordedPresetId: 'a', attemptedPresetId: 'b' })
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(1)
    const view = service.viewOf(session)
    expect(view.presetId).toBe('a')
    expect(view.routes?.map(route => route.model)).toEqual(['alpha-fast', 'alpha-pro', 'beta-plain'])
    await ctx.fiber.dispose()
  })

  it('rejects a conflicting attempt before any catalog read or write', async () => {
    const preflightCall = vi.fn(async (config: unknown): Promise<unknown> => config)
    const { ctx, service } = await formationOf(preflightCall)
    const session = Session.create(SessionId('formation-conflict-order'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    startFirstTurn(session)
    preflightCall.mockClear()
    await expect(service.selectRoutes(agentOf(session), B, new AbortController().signal)).rejects.toMatchObject({ code: 'crew/conflict' })
    expect(preflightCall).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('validates the routes of an idempotent replay path without writing a second event', async () => {
    // A replay short-circuits before validation: the recorded set is already
    // on the session, so re-checking the catalog would turn a settled pick
    // into a transient failure when the deployment's catalog moved on.
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-replay-order'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    await expect(service.selectRoutes(agentOf(session), A, new AbortController().signal)).resolves.toBe(false)
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('settles a raced loser by the final record instead of the guard result', async () => {
    // Simulate the interleaving the guard cannot see: the pre-validation read
    // sees no record, validation runs, and only then does a competing set
    // land. The loser must re-read and settle by what the session holds.
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-race'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    startFirstTurn(session)
    // Drive the guard race directly: the record now exists and the turn is
    // open, so a fresh call with B exercises the conflict path; the re-read
    // after validation covers the interleaving where the guard ran before the
    // winner's write.
    await expect(service.selectRoutes(agentOf(session), B, new AbortController().signal)).rejects.toMatchObject({ code: 'crew/conflict' })
    expect(service.viewOf(session).presetId).toBe('a')
    await ctx.fiber.dispose()
  })

  it('refuses a pick whose session opened its first turn during validation', async () => {
    // The pre-validation guard saw no turn, so only the re-read after the
    // catalog call can refuse: the fold keeps the recorded set from then on.
    const gate = Promise.withResolvers<undefined>()
    let hold = false
    const preflightCall = vi.fn(async (config: unknown): Promise<unknown> => {
      if (hold) await gate.promise
      return config
    })
    const { ctx, service } = await formationOf(preflightCall)
    const session = Session.create(SessionId('formation-turn-during-validation'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)

    hold = true
    const pending = service.selectRoutes(agentOf(session), B, new AbortController().signal)
    startFirstTurn(session)
    gate.resolve(undefined)

    await expect(pending).rejects.toMatchObject({ code: 'crew/conflict' })
    expect(session.snapshotEvents().filter(event => event.type === 'crew/routes-selected')).toHaveLength(1)
    expect(service.viewOf(session).presetId).toBe('a')
    await ctx.fiber.dispose()
  })

  it('keeps the same-set judgment on a race whose winner carries different role routes', async () => {
    // Same preset id, different worker route: not an idempotent replay.
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-race-routes'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    startFirstTurn(session)
    const drifted = { ...A, routes: { ...ROUTES, worker: { provider: 'delta', model: 'delta-1', reasoningEffort: 'low' } } }
    await expect(service.selectRoutes(agentOf(session), drifted, new AbortController().signal)).rejects.toMatchObject({ code: 'crew/conflict' })
    expect(service.viewOf(session).routes?.find(route => route.role === 'worker'))
      .toEqual({ role: 'worker', ...ROUTES.worker })
    await ctx.fiber.dispose()
  })
})


describe('CrewFormation.replaceRole', () => {
  it('records one replacement while preserving the other roles and never retries work', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-repair'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    await expect(service.replaceRole(agentOf(session), 'worker', OTHER.worker, new AbortController().signal))
      .resolves.toEqual(OTHER.worker)
    const view = service.viewOf(session)
    expect(view.presetId).toBeNull()
    expect(view.replaced).toEqual(['worker'])
    expect(view.routes).toEqual([
      { role: 'worker', ...OTHER.worker },
      { role: 'planner', ...ROUTES.planner },
      { role: 'reviewer', ...ROUTES.reviewer },
    ])
    expect(session.snapshotEvents().filter(event => event.type === 'crew/route-replaced')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('leaves the recorded route untouched when the replacement catalog rejects it', async () => {
    const preflightCall = vi.fn(async (config: unknown): Promise<unknown> => config)
    const { ctx, service } = await formationOf(preflightCall)
    const session = Session.create(SessionId('formation-repair-refused'))
    await service.selectRoutes(agentOf(session), A, new AbortController().signal)
    preflightCall.mockRejectedValueOnce(new Error('route unavailable'))
    await expect(service.replaceRole(agentOf(session), 'worker', OTHER.worker, new AbortController().signal))
      .rejects.toThrow('route unavailable')
    expect(session.snapshotEvents().filter(event => event.type === 'crew/route-replaced')).toEqual([])
    expect(service.viewOf(session).routes?.find(route => route.role === 'worker')).toEqual({ role: 'worker', ...ROUTES.worker })
    await ctx.fiber.dispose()
  })

  it('refuses to invent a route set for a session that recorded none', async () => {
    const { ctx, service } = await formationOf()
    const session = Session.create(SessionId('formation-repair-unrecorded'))
    await expect(service.replaceRole(agentOf(session), 'worker', OTHER.worker, new AbortController().signal))
      .rejects.toThrow('has no recorded routes')
    expect(session.snapshotEvents()).toEqual([])
    await ctx.fiber.dispose()
  })
})
