/** Write guard a delegation tool installs on the worker-route setting it reads. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { subagentWorkerRouteMark } from './worker-route-state.ts'

/**
 * Why one delegated worker blocks a route rewrite right now.
 *
 * Only a worker that follows the setting is affected by a rewrite: a child the
 * setting never routed — one whose call named its own route, or one created
 * before the opt-in — keeps its creation route, so a rewrite leaves it alone
 * and must not be held by it. Of the workers that do follow the setting, only
 * a running one is at risk: it re-reads the setting at its next request, and a
 * rewrite that lands while a request is being assembled would change the route
 * of work already in flight. The predicate cannot tell request assembly apart
 * from the gaps between a turn's requests, so the whole running turn holds the
 * write. Settled and failed workers stay continuable but are not in use, so
 * they never hold the write — that is the window the recovery flow needs.
 * @param projections - the session projection registry reading the marker.
 * @param agents - live Agents owned by the composing deployment.
 * @returns the refusal reason, or undefined when no following worker runs.
 */
export function workerRouteWriteRefusal(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  agents: readonly Agent[],
): string | undefined {
  const running = agents.find(agent =>
    agent.session.header.origin === 'subagent'
    && agent.status === 'running'
    && subagentWorkerRouteMark(projections, agent.session) !== undefined)
  if (running === undefined) return undefined
  return `delegated worker "${running.id}" is running and follows this route; stop it or wait for its turn to settle before changing the worker route`
}
