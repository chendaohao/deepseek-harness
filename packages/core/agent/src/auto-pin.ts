/**
 * The Workspace registry's automatic-pin feed: an Agent entering or leaving
 * `running` notes the visible Session's activity transition, so the registry
 * can pin active Sessions itself and drop the pin after their idle timeout.
 * A subagent's activity notes its nearest non-subagent ancestor — the Session
 * grouping surfaces show. Installed by the registry's constructor alongside
 * the archive admission. The Workspace registry is an optional peer (a
 * composition may omit it); a noting failure is logged, never thrown into
 * the loop that reported the transition.
 *
 * @module @deepseek-ai/dsh-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the Workspace registry's Context service merge.
import type {} from '@deepseek-ai/dsh-workspace'

/** Subagent nesting is shallow; the bound only guards a corrupt parent cycle. */
const MAX_LINEAGE_DEPTH = 8

/**
 * Resolve the session the grouping surfaces show for one Agent's activity:
 * the session itself, or its nearest non-subagent ancestor.
 * @param ctx - lookup context for the live session store.
 * @param session - the session the reporting Agent drives.
 * @returns the visible Session id, or undefined when the lineage is broken.
 */
function visibleSessionId(ctx: Context, session: Session): SessionId | undefined {
  let current: Session = session
  for (let depth = 0; ; depth++) {
    if (current.header.origin !== 'subagent') return current.id
    if (depth >= MAX_LINEAGE_DEPTH) return undefined
    const parentId = current.header.parentSession
    if (parentId === undefined) return undefined
    const parent = ctx.get('sessions')?.get(parentId)
    if (parent === undefined) return undefined
    current = parent
  }
}

/**
 * Note every Agent status transition to the Workspace registry's automatic
 * pin feed. The listener lives as long as `ctx`'s fiber.
 * @param ctx - the registry's registration context.
 */
export function installActivityAutoPin(ctx: Context): void {
  ctx.on('agent/status', ({ agent, status }) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    const sessionId = visibleSessionId(ctx, agent.session)
    if (sessionId === undefined) return
    registry.noteSessionActivity(sessionId, status === 'running' ? 'active' : 'idle')
      .catch((reason: unknown) => {
        ctx.logger.warn('agent: automatic pin note for session \'' + String(sessionId) + '\' failed: ' + String(reason))
      })
  })
}
