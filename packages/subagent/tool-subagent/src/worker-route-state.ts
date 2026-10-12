/** Durable marker that one delegation child's route follows the Host worker-route setting. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE } from './worker-route-settings.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this Session's LLM route follows the named Host settings
     * namespace instead of the route baked at creation, so every later
     * activation — a cold resume included — re-resolves it. Appended by the
     * delegation tool that opted into `workerRouteSettings`; absence means the
     * route fixed at creation. Log-only: it carries no `surfaceOp` and never
     * enters model history.
     */
    'subagent/worker-route': {
      /** User-settings namespace this Session's route follows. */
      namespace: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Settings namespace this Session's route follows, or null without the marker. */
    subagentWorkerRoute: string | null
  }
}

const workerRouteNamespaceSchema: zod.ZodType<string | null> = zod.string().min(1).nullable()

/** Host-only projection of the durable worker-route marker. */
export const subagentWorkerRouteProjectionDefinition = {
  key: 'subagentWorkerRoute',
  stateVersion: 1,
  stateSchema: workerRouteNamespaceSchema,
  init: () => null,
  apply: (namespace, event) => {
    if (namespace !== null || event.type !== 'subagent/worker-route') return namespace
    const { namespace: marked } = event.data
    if (marked.length === 0) throw new Error('subagent/worker-route requires a non-empty namespace')
    return marked
  },
} satisfies ProjectionDefinition<'subagentWorkerRoute', string | null>

/**
 * Read the settings namespace one Session's route follows.
 * @param projections - registry that owns the marker projection.
 * @param session - session whose durable marker is read.
 * @returns the marked namespace, or undefined for the creation-fixed route.
 */
export function subagentWorkerRouteMark(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): string | undefined {
  return projections.stateOf(session, 'subagentWorkerRoute') ?? undefined
}

/**
 * Append the marker once, so a later activation of this child re-resolves its
 * route from the Host setting rather than the route it was created with. The
 * caller records it only for a child whose effective route is that setting's own.
 * @param projections - registry that owns the marker projection.
 * @param session - child session receiving the marker.
 */
export function recordSubagentWorkerRoute(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): void {
  if (subagentWorkerRouteMark(projections, session) !== undefined) return
  session.append('subagent/worker-route', { namespace: SUBAGENT_WORKER_ROUTE_SETTINGS_NAMESPACE })
}
