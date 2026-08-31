/**
 * Pure types of the session-pin domain: the ONE home of the `pinned`
 * projection-key declaration, free of this package's host-side value imports
 * (cordis service, schemastery). The client namespace re-exports this file, so
 * host and client consumers see the same single source.
 *
 * @module @deepseek-ai/dsh-session-pin/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/**
 * Folded pin state: the flag plus the pin event's wall-clock time, which list
 * surfaces use to order the pinned group (newest pin first).
 */
export interface SessionPinState {
  /** Whether the session is pinned above unpinned sessions. */
  readonly pinned: boolean
  /** Time of the latest `session/pin` event; null before any pin event. */
  readonly pinAt: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    pinned: SessionPinState
  }
  interface SessionProjectionMap {
    /**
     * The session's current pin state — the latest `session/pin` event's
     * value (last-wins), or `{ pinned: false, pinAt: null }` before the
     * first pin event lands. The shape list rows consume.
     */
    pinned: SessionPinState
  }
}
