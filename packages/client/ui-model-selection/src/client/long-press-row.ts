/**
 * Row gesture shared by pointer and keyboard: one delegated long press plus
 * the context-menu gesture every platform already sends.
 *
 * The container owns the gesture rather than each row, because rows are
 * rebuilt whenever the list changes and a per-row timer would be lost with
 * them. A hold that turns into a scroll (travel past
 * {@link LONG_PRESS_SLOP_PX}, or the browser claiming the touch with
 * `pointercancel`) never fires.
 *
 * A fired hold leaves two echoes behind: Android reports the same press as a
 * `contextmenu`, and the release produces a click — on whichever row now sits
 * under the finger, which after a removal is a different route. Both are
 * dropped for {@link ECHO_WINDOW_MS}, and any fresh press cancels that window,
 * so a deliberate second gesture is never swallowed.
 */
import { useCallback, useEffect, useRef, type HTMLAttributes, type MouseEvent, type PointerEvent } from 'react'

/** Hold before a touch press counts as a long press. */
export const LONG_PRESS_MS = 500

/** Travel that turns a hold into a scroll or drag. */
export const LONG_PRESS_SLOP_PX = 10

/** How long a fired hold owns the follow-up gestures its own press produces. */
export const ECHO_WINDOW_MS = 1000

/** Container handlers implementing the gesture. */
export type RowGestureProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onContextMenu' | 'onClickCapture'
>

/** One hold in progress, kept off render state so a rerender cannot restart it. */
interface Press {
  readonly timer: ReturnType<typeof setTimeout>
  readonly row: HTMLElement
  readonly x: number
  readonly y: number
}

/**
 * Bind the row gesture to one container.
 * @param rowSelector - matches the rows the gesture may act on.
 * @param run - acts on the row the gesture landed on; read at fire time, so a
 * fresh closure per render is fine.
 * @returns handlers for the container element.
 */
export function useRowGesture(rowSelector: string, run: (row: HTMLElement) => void): RowGestureProps {
  const press = useRef<Press | null>(null)
  /** Instant until which the fired hold owns the platform's follow-up `contextmenu`. */
  const echoUntil = useRef(0)
  /** Whether the fired hold still owes the one click its own release produces. */
  const releaseClick = useRef(false)
  const action = useRef(run)
  action.current = run

  const stop = useCallback((): void => {
    if (press.current === null) return
    clearTimeout(press.current.timer)
    press.current = null
  }, [])

  useEffect(() => stop, [stop])

  const rowOf = useCallback((target: EventTarget | null): HTMLElement | null => {
    /* v8 ignore next -- React retargets every delegated pointer and mouse event to an Element. */
    if (!(target instanceof Element)) return null
    return target.closest<HTMLElement>(rowSelector)
  }, [rowSelector])

  const fire = useCallback((row: HTMLElement): void => {
    echoUntil.current = Date.now() + ECHO_WINDOW_MS
    releaseClick.current = true
    action.current(row)
  }, [])

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>): void {
      // Any new press owns its own activation, so an earlier hold's window ends.
      echoUntil.current = 0
      releaseClick.current = false
      // A mouse hold is not this gesture: the context-menu path covers it.
      if (event.button !== 0 || event.pointerType === 'mouse') return
      const row = rowOf(event.target)
      if (row === null) return
      stop()
      press.current = {
        row,
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press.current = null
          fire(row)
        }, LONG_PRESS_MS),
      }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>): void {
      const current = press.current
      if (current === null) return
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > LONG_PRESS_SLOP_PX) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onContextMenu(event: MouseEvent<HTMLDivElement>): void {
      const row = rowOf(event.target)
      if (row === null) return
      // Right click, Shift+F10, and the ContextMenu key all arrive here.
      event.preventDefault()
      if (Date.now() < echoUntil.current) return
      // An armed hold for this row is the press this native menu reports; the
      // timer owns that single activation.
      if (press.current?.row === row) return
      stop()
      fire(row)
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>): void {
      // Only the click the fired hold's own release produces is dropped; the
      // next deliberate click, by pointer or key, is the user's.
      if (!releaseClick.current) return
      releaseClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}
