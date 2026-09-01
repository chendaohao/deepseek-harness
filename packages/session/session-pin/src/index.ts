/**
 * Log-backed session pin service: append-only `session/pin` events and the
 * `pinned` projection unit. The list surfaces read the projection; nothing
 * here touches the model surface or derived history.
 * @module @deepseek-ai/dsh-session-pin
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionPinState } from './types.ts'
// Type-only: resolves ctx.sessionProjections for the optional unit child and
// pulls the projection table merges into programs that consume the wire view.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `pinned` projection-key declaration lives in src/types.ts (its one
// home); this re-export projects the type face onto the package root AND keeps
// the module edge in the emitted index.d.ts, so aggregate programs consuming
// the declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

/** Payload of the log-only `session/pin` event. */
export interface SessionPinEventData {
  /** Whether the session became pinned (true) or unpinned (false). */
  readonly pinned: boolean
}

/** Latest folded pin state plus the pin event's durable envelope facts. */
export interface SessionPinSnapshot extends SessionPinEventData {
  /** Seq of the latest `session/pin` event. */
  readonly eventSeq: number
  /** Timestamp of the latest `session/pin` event. */
  readonly updatedAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPin: SessionPinService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins session pin snapshot. Log-only: it never enters the model
     * surface or derived history.
     */
    'session/pin': SessionPinEventData
  }
}

/**
 * Fold the latest `session/pin` event from a session's event log.
 * @param events - the session's event log rows.
 * @returns the pin snapshot carried by the latest pin event, or undefined when none exists.
 */
export function foldSessionPin(
  events: readonly { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }[],
): SessionPinSnapshot | undefined {
  const event = [...events].reverse().find(item => item.type === 'session/pin')
  if (event === undefined) return undefined
  const data = event.data as SessionPinEventData
  return { pinned: data.pinned, eventSeq: event.seq, updatedAt: event.time }
}

/** Log-backed session pin service. */
export class SessionPinService extends Service {
  static inject = ['sessions']

  constructor(ctx: Context) {
    super(ctx, 'sessionPin')

    // The pin projection unit: pure last-wins fold of session/pin events,
    // serving the pin state list rows read. The unit child activates only when
    // a projection registry is composed (headless assemblies stay unaffected).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      const pinnedStateSchema = zod.object({
        pinned: zod.boolean(),
        pinAt: zod.number().nullable(),
      })
      const pinnedSchema = zod.object({
        pinned: zod.boolean(),
        pinAt: zod.number().nullable(),
      })
      projectionCtx.sessionProjections.register<'pinned', SessionPinState>({
        key: 'pinned',
        stateSchema: pinnedStateSchema,
        init: () => ({ pinned: false, pinAt: null }),
        apply: (state, event) => (event.type === 'session/pin'
          ? { pinned: event.data.pinned, pinAt: event.time }
          : state),
        wire: { viewSchema: pinnedSchema, view: state => state },
        stateVersion: 1,
      })
    })
  }

  /**
   * Set or clear the pin on one live session by appending a `session/pin`
   * event. The event log is append-only, so committing the current value
   * again is allowed; callers that need a no-op read the folded state first.
   * @param session - live session to pin or unpin.
   * @param pinned - whether the session should be pinned.
   * @returns the folded pin snapshot after the append.
   * @throws {Error} when the session is not live in this store.
   */
  setPin(session: Session, pinned: boolean): SessionPinSnapshot {
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    session.append('session/pin', { pinned })
    const snapshot = foldSessionPin(session.events)
    /* v8 ignore next -- unreachable: the append above just committed a session/pin event. */
    if (snapshot === undefined) throw new Error('pin state failed to fold')
    return snapshot
  }

  /**
   * Read the latest folded pin state from one live or replayed session.
   * @param session - session whose log is the pin source of truth.
   * @returns latest pin snapshot, or `undefined` before any pin event.
   */
  get(session: Session): SessionPinSnapshot | undefined {
    return foldSessionPin(session.events)
  }
}

export default SessionPinService
