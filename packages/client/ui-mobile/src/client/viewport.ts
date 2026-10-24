/**
 * Undo the document-level scroll offset a phone browser applies on its own.
 *
 * Every scrolling region in this GUI is an inner element (the session list, the
 * transcript, the file pane); the document itself is an app shell that must stay
 * at offset zero. Chrome on Android nevertheless scrolls the document when it
 * reveals a focused field, restores a saved offset as the page returns from the
 * background, or re-anchors as its address bar collapses. The shell paints from
 * the frame's top edge, so any document offset clips the whole app by exactly
 * that amount — the reported symptom is the interface sitting a half or an
 * eighth of a screen too high after switching apps, with no way to drag it back
 * because the frame owns its own overflow.
 *
 * The height half of the same defect lives in `touch.css` (`100dvh`): a shell
 * sized to the layout viewport overflows the visible band by one address-bar
 * height, which is what gives the browser something to scroll in the first place.
 *
 * A soft keyboard is the case this must NOT fight: while it is up the shell is
 * taller than the band above it, and the browser scrolls the document on purpose
 * to keep the focused field visible. The reset therefore stands down while the
 * visual viewport is shorter than its keyboard-closed baseline, and takes the
 * offset back the moment that baseline returns.
 *
 * One correction is not enough. A resume fires a reset at the exact moment the
 * browser is still restoring its own saved offset, so a single write loses that
 * race and the offset lands a frame later. Every resume therefore keeps sampling
 * for {@link RESUME_SETTLE_MS}, which costs a handful of property reads and closes
 * the gap between "the event fired" and "the browser finished putting things back".
 * @module @deepseek-ai/dsh-client-ui-mobile/viewport
 */

/** A scroll offset pair; the document's scrolling element narrows to this. */
export interface ScrollOffset {
  /** Vertical document offset. */
  scrollTop: number
  /** Horizontal document offset. */
  scrollLeft: number
}

/** The document facts this module reads, stated structurally for test seams. */
export interface ViewportDocument extends EventTarget {
  /** Current document visibility, compared against `'visible'`. */
  readonly visibilityState: string
  /** The element that scrolls the document, or null before layout. */
  readonly scrollingElement: ScrollOffset | null
}

/** The window facts this module reads, stated structurally for test seams. */
export interface ViewportWindow extends EventTarget {
  /** Document pinned to offset zero. */
  readonly document: ViewportDocument
  /** Visual viewport (address-bar and keyboard geometry); absent on some engines. */
  readonly visualViewport?: (EventTarget & { readonly height: number }) | null | undefined
  /** Queue one frame callback; the browser returns a cancellation handle. */
  requestAnimationFrame(callback: FrameRequestCallback): number
  /** Cancel a queued frame callback. */
  cancelAnimationFrame(handle: number): void
  /** Arm a one-shot timer, for the resume settle window. */
  setTimeout(callback: () => void, ms: number): number
  /** Disarm a one-shot timer. */
  clearTimeout(handle: number): void
}

/** Environment seams, injectable so specs need no real browser layout. */
export interface ViewportResetSeams {
  /** Window whose document is pinned; defaults to the global window. */
  readonly window?: ViewportWindow | undefined
  /** Document to reset; defaults to the window's own document. */
  readonly document?: ViewportDocument | undefined
}

/**
 * Reset the document's scroll offset whenever the browser may have moved it.
 *
 * The listeners only observe: they never capture a gesture and never scroll an
 * inner region, so a phone that is mid-swipe keeps its pan.
 * @param seams - window and document sources; defaults to the browser globals.
 * @returns a function removing every listener; idempotent.
 */
/** Share of the keyboard-closed height the viewport must still show to count as closed. */
const KEYBOARD_CLOSED_RATIO = 0.9

/**
 * How long a resume keeps being sampled. The browser restores its own document
 * offset some frames after the event that announces the return, so one write at
 * event time can be overwritten by that restore.
 */
const RESUME_SETTLE_MS = 1200

export function installViewportReset(seams: ViewportResetSeams = {}): () => void {
  const win = seams.window ?? globalThis.window
  const doc = seams.document ?? win.document
  const viewport = win.visualViewport ?? null
  let pending: number | null = null
  // Largest height this viewport has reported: the keyboard-closed band. A soft
  // keyboard only ever makes it shorter, so the maximum is the baseline.
  let closedHeight = viewport?.height ?? 0

  /**
   * Whether the browser scrolled the document to reveal a field above a soft
   * keyboard, where that offset is intentional for as long as the keyboard stays.
   * @returns true while a viewport shorter than the baseline is on screen.
   */
  const keyboardHoldsOffset = (): boolean => {
    if (viewport === null) return false
    if (viewport.height > closedHeight) closedHeight = viewport.height
    return viewport.height < closedHeight * KEYBOARD_CLOSED_RATIO
  }

  const reset = (): void => {
    pending = null
    if (keyboardHoldsOffset()) return
    const scroller = doc.scrollingElement
    if (scroller === null) return
    // Assigning 0 when already 0 still fires a scroll event in some engines, so
    // each axis is checked before it is written.
    if (scroller.scrollTop !== 0) scroller.scrollTop = 0
    if (scroller.scrollLeft !== 0) scroller.scrollLeft = 0
  }
  // Coalesced to one frame: the visual viewport reports every address-bar
  // animation step, and a synchronous write per step would fight the compositor.
  const schedule = (): void => {
    if (pending !== null) return
    pending = win.requestAnimationFrame(reset)
  }
  // A resume needs more than one sample: see RESUME_SETTLE_MS.
  let settle: number | null = null
  const scheduleResume = (): void => {
    schedule()
    if (settle !== null) win.clearTimeout(settle)
    settle = win.setTimeout(() => {
      settle = null
      schedule()
    }, RESUME_SETTLE_MS)
  }
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'visible') scheduleResume()
  }

  // The visual viewport may be absent (older engines, some embedded WebViews);
  // the window still reports the resize, so the pair degrades to the same guard.
  const targets: ReadonlyArray<readonly [EventTarget, string, EventListener]> = [
    [win, 'resize', schedule],
    [win, 'pageshow', scheduleResume],
    [doc, 'visibilitychange', onVisibilityChange],
    ...(viewport === null
      ? []
      : [
        [viewport, 'resize', schedule],
        [viewport, 'scroll', schedule],
      ] as const),
  ]
  for (const [target, type, listener] of targets) target.addEventListener(type, listener, { passive: true })

  return () => {
    if (pending !== null) win.cancelAnimationFrame(pending)
    pending = null
    if (settle !== null) win.clearTimeout(settle)
    settle = null
    for (const [target, type, listener] of targets) target.removeEventListener(type, listener)
  }
}
