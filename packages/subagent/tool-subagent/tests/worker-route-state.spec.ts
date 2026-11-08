/** Durable worker-route marker and its Host-only projection. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, { type ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import {
  recordSubagentWorkerRoute,
  subagentWorkerRouteMark,
  subagentWorkerRouteProjectionDefinition,
} from '../src/worker-route-state.ts'
import { SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE } from '../src/worker-route-settings.ts'

/** A context owning only the projection registry the marker folds through, plus the retained marker handle. */
async function projectionContext(): Promise<{ ctx: Context; workerRoute: ProjectionHandle<string | null> }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const workerRoute = await ctx.sessionProjections.register(subagentWorkerRouteProjectionDefinition)
  return { ctx, workerRoute }
}

describe('subagent/worker-route marker', () => {
  it('records the marker once and reads it back', async () => {
    const { ctx, workerRoute } = await projectionContext()
    const session = Session.create(SessionId('marked-child'))
    expect(subagentWorkerRouteMark(workerRoute, session)).toBeUndefined()

    recordSubagentWorkerRoute(workerRoute, session, SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE)
    recordSubagentWorkerRoute(workerRoute, session, SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE)

    expect(session.snapshotEvents().filter(event => event.type === 'subagent/worker-route')).toHaveLength(1)
    expect(subagentWorkerRouteMark(workerRoute, session))
      .toBe(SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE)
    await ctx.fiber.dispose()
  })

  it('refuses an empty namespace in a stored log', async () => {
    const { ctx, workerRoute } = await projectionContext()
    const session = Session.create(SessionId('empty-namespace'))
    session.append('subagent/worker-route', { namespace: '' })

    expect(() => subagentWorkerRouteMark(workerRoute, session))
      .toThrow('requires a non-empty namespace')
    await ctx.fiber.dispose()
  })
})
