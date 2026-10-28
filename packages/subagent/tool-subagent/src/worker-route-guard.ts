/** Write guard a delegation tool installs on the route setting it reads. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { subagentWorkerRouteMark } from './worker-route-state.ts'

/**
 * Why one delegated child blocks a route rewrite right now.
 *
 * Only a child that follows this namespace is affected by a rewrite: one whose
 * marker names another namespace — or that carries none — keeps its creation
 * route, so a rewrite leaves it alone and must not be held by it. Of the
 * children that do follow it, only a running one is at risk: it re-reads the
 * setting at its next request, and a rewrite that lands while a request is
 * being assembled would change the route of work already in flight. The
 * predicate cannot tell request assembly apart from the gaps between a turn's
 * requests, so the whole running turn holds the write. Settled and failed
 * children stay continuable but are not in use, so they never hold the write —
 * that is the window the recovery flow needs.
 * @param projections - the session projection registry reading the marker.
 * @param agents - live Agents owned by the composing deployment.
 * @param namespace - settings namespace whose writes are being judged.
 * @returns the refusal reason, or undefined when no following child runs.
 */
export function subagentRouteWriteRefusal(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  agents: readonly Agent[],
  namespace: string,
): string | undefined {
  const running = agents.find(agent =>
    agent.session.header.origin === 'subagent'
    && agent.status === 'running'
    && subagentWorkerRouteMark(projections, agent.session) === namespace)
  if (running === undefined) return undefined
  return `delegated child "${running.id}" is running and follows this route; stop it or wait for its turn to settle before changing the route`
}
