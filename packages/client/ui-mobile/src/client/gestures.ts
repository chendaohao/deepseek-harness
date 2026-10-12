/**
 * Swipe gestures for the sidebar, for phone-class pointers only.
 *
 * The shipped narrow layout already gives the sidebar the right geometry: below
 * 1024px it floats above the full-width center with a tap-away backdrop
 * (`ui-layout` AppFrame), and the collapsed rail keeps its own toggle button. So
 * this adds no control and no slot — only the swipe that phone users reach for.
 *
 * Scroll safety is the whole design constraint. Listeners are passive and never
 * call `preventDefault`, so the browser keeps ownership of panning; the gesture
 * only observes. A pointer that travels mostly vertically is abandoned on first
 * movement, so a scroll never becomes a toggle. Opening requires the touch to
 * begin in the left edge zone, because a rightward drag that starts mid-page is
 * far more likely to be a text selection or a horizontal scroll than an intent
 * to open the sidebar.
 * @module @deepseek-ai/dsh-client-ui-mobile/gestures
 */

/** Distance a touch must travel horizontally before the gesture commits (px). */
export const GESTURE_SLOP_PX = 10
/** Horizontal distance that completes a committed swipe (px). */
export const GESTURE_DISTANCE_PX = 60
/** Left-edge band, measured from the viewport's left, where opening may begin (px). */
export const GESTURE_EDGE_ZONE_PX = 32

/** State and actions the gesture reads and drives, injected so specs need no DOM layout. */
export interface GestureSeams {
  /** Whether the narrow sidebar is currently expanded (floating above the center). */
  isSidebarExpanded: () => boolean
  /** Toggle the sidebar panel. */
  toggleSidebar: () => void
  /** Pointer events source; defaults to the document. */
  readonly target?: EventTarget | undefined
}

/** One in-flight touch being adjudicated. */
interface GestureTrack {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  /** Set once the movement is unambiguously a sidebar swipe; null while undecided. */
  intent: 'open' | 'close' | null
}

/**
 * Install the sidebar swipe gestures and return the uninstaller.
 * @param seams - sidebar state, the toggle action, and the event target.
 * @returns a function removing every listener; idempotent.
 */
export function installSidebarGestures(seams: GestureSeams): () => void {
  const target = seams.target ?? document
  let track: GestureTrack | undefined

  const reset = (): void => { track = undefined }

  const onDown = (event: Event): void => {
    const down = event as PointerEvent
    // A mouse or trackpad has the rail button and the keyboard; only a finger
    // or stylus gets the swipe.
    if (down.pointerType === 'mouse' || !down.isPrimary) return
    track = { pointerId: down.pointerId, startX: down.clientX, startY: down.clientY, intent: null }
  }

  const onMove = (event: Event): void => {
    const move = event as PointerEvent
    const current = track
    if (current === undefined || move.pointerId !== current.pointerId) return
    const dx = move.clientX - current.startX
    const dy = move.clientY - current.startY
    if (current.intent === null) {
      // Vertical dominance abandons the gesture before any slop is reached, so
      // an ordinary scroll can never be reinterpreted as a toggle.
      if (Math.abs(dy) > Math.abs(dx)) { reset(); return }
      if (Math.abs(dx) < GESTURE_SLOP_PX) return
      if (seams.isSidebarExpanded()) {
        // Open sidebar: only a leftward drag closes it.
        if (dx >= 0) { reset(); return }
        current.intent = 'close'
      } else {
        // Closed sidebar: opening must start at the left edge.
        if (dx <= 0 || current.startX > GESTURE_EDGE_ZONE_PX) { reset(); return }
        current.intent = 'open'
      }
    }
    const travelled = current.intent === 'close' ? -dx : dx
    if (travelled < GESTURE_DISTANCE_PX) return
    // Commit at the threshold and drop the track, so one swipe toggles once.
    reset()
    seams.toggleSidebar()
  }

  const listeners: ReadonlyArray<readonly [string, EventListener]> = [
    ['pointerdown', onDown],
    ['pointermove', onMove],
    ['pointerup', reset],
    ['pointercancel', reset],
  ]
  for (const [type, listener] of listeners) {
    // Passive: the gesture observes panning and never competes with it.
    target.addEventListener(type, listener, { passive: true })
  }
  return () => {
    reset()
    for (const [type, listener] of listeners) target.removeEventListener(type, listener)
  }
}