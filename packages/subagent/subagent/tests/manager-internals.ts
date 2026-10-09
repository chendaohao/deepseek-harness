/** Package-private manager state used to place deterministic lifecycle races. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentManager from '../src/manager.ts'

/** Resolve the private package state for one activation, as the tests inspect it. */
export function activationInternals(ctx: Context, childId: SessionId) {
  const activation = managerState(ctx).resident.get(childId)
  if (activation === undefined) throw new Error(`expected a resident activation for "${childId}"`)
  if (activation.kind !== 'local') throw new Error(`expected a local activation for "${childId}"`)
  return activation.handle
}

/** Return the service's bound subagent manager. */
export function subagentManager(ctx: Context): SubagentManager {
  const manager = ctx.subagents['manager']
  if (manager === undefined) throw new Error('expected a bound subagent manager')
  return manager
}

/** Read private lifecycle state for deterministic race placement. */
export function managerState(ctx: Context) {
  const manager = subagentManager(ctx)
  return {
    resident: manager['resident'],
    locks: manager['locks'],
    ownerCtx: manager['ownerCtx'],
  }
}

/** Remove only the map entry, leaving its Agent live for collision coverage. */
export function dropActivation(ctx: Context, childId: SessionId): void {
  managerState(ctx).resident.delete(childId)
}
