// @vitest-environment jsdom
/**
 * Sidebar swipe gestures. The scroll-safety rules are the behavior worth
 * pinning: a vertical pan must never toggle, a mid-page rightward drag must
 * never open, and one swipe must toggle exactly once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GESTURE_DISTANCE_PX, GESTURE_EDGE_ZONE_PX, GESTURE_SLOP_PX, installSidebarGestures,
} from '../src/client/gestures.ts'

/** One installed gesture set plus its recorded toggles. */
interface Bench {
  toggles: number
  expanded: boolean
  uninstall: () => void
  down: (x: number, y: number, init?: PointerEventInit) => void
  move: (x: number, y: number, init?: PointerEventInit) => void
  up: (init?: PointerEventInit) => void
}

/** Pointer events jsdom does not construct from plain `Event`. */
function pointerEvent(type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'touch', ...init,
  })
}

function bench(startExpanded = false): Bench {
  const state = { expanded: startExpanded, toggles: 0 }
  const uninstall = installSidebarGestures({
    isSidebarExpanded: () => state.expanded,
    toggleSidebar: () => {
      state.toggles++
      state.expanded = !state.expanded
    },
  })
  return {
    get toggles() { return state.toggles },
    get expanded() { return state.expanded },
    set expanded(value: boolean) { state.expanded = value },
    uninstall,
    down: (x, y, init) => { document.dispatchEvent(pointerEvent('pointerdown', x, y, init)) },
    move: (x, y, init) => { document.dispatchEvent(pointerEvent('pointermove', x, y, init)) },
    up: (init) => { document.dispatchEvent(pointerEvent('pointerup', 0, 0, init)) },
  }
}

const benches: Bench[] = []
afterEach(() => {
  for (const b of benches.splice(0)) b.uninstall()
})

function fresh(expanded = false): Bench {
  const b = bench(expanded)
  benches.push(b)
  return b
}

describe('installSidebarGestures', () => {
  it('opens from a left-edge rightward swipe', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400)
    b.move(10 + GESTURE_DISTANCE_PX, 402)
    expect(b.toggles).toBe(1)
    expect(b.expanded).toBe(true)
  })

  it('does not open from a rightward swipe that starts mid-page', () => {
    const b = fresh(false)
    b.down(GESTURE_EDGE_ZONE_PX + 1, 400)
    b.move(GESTURE_EDGE_ZONE_PX + 1 + GESTURE_SLOP_PX, 400)
    b.move(GESTURE_EDGE_ZONE_PX + 1 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('does not open from a leftward swipe', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 - GESTURE_SLOP_PX, 400)
    b.move(10 - GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('closes from a leftward swipe while the sidebar is expanded', () => {
    const b = fresh(true)
    b.down(200, 400)
    b.move(200 - GESTURE_SLOP_PX, 400)
    b.move(200 - GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(1)
    expect(b.expanded).toBe(false)
  })

  it('does not close from a rightward swipe while expanded', () => {
    const b = fresh(true)
    b.down(200, 400)
    b.move(200 + GESTURE_SLOP_PX, 400)
    b.move(200 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('abandons a gesture as soon as it turns vertical, so a scroll never toggles', () => {
    const b = fresh(false)
    b.down(10, 400)
    // Vertical dominance first: the swipe is given up before any slop.
    b.move(14, 430)
    b.move(10 + GESTURE_DISTANCE_PX, 430)
    expect(b.toggles).toBe(0)
  })

  it('ignores movement below the slop threshold', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX - 1, 400)
    expect(b.toggles).toBe(0)
  })

  it('toggles once per swipe even if the drag continues past the threshold', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400)
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    b.move(10 + GESTURE_DISTANCE_PX * 3, 400)
    expect(b.toggles).toBe(1)
  })

  it('ignores a mouse pointer, which has the rail button and the keyboard', () => {
    const b = fresh(false)
    b.down(10, 400, { pointerType: 'mouse' })
    b.move(10 + GESTURE_SLOP_PX, 400, { pointerType: 'mouse' })
    b.move(10 + GESTURE_DISTANCE_PX, 400, { pointerType: 'mouse' })
    expect(b.toggles).toBe(0)
  })

  it('ignores a non-primary pointer', () => {
    const b = fresh(false)
    b.down(10, 400, { isPrimary: false })
    b.move(10 + GESTURE_SLOP_PX, 400)
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('ignores movement that never began with a pointerdown', () => {
    const b = fresh(false)
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('ignores movement from a different pointer than the one that went down', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400, { pointerId: 2 })
    b.move(10 + GESTURE_DISTANCE_PX, 400, { pointerId: 2 })
    expect(b.toggles).toBe(0)
  })

  it('ends the gesture on pointerup, so a later drag is not a continuation', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400)
    b.up()
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('ends the gesture on pointercancel', () => {
    const b = fresh(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400)
    document.dispatchEvent(pointerEvent('pointercancel', 0, 0))
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('removes every listener on uninstall, and uninstall is idempotent', () => {
    const b = bench(false)
    b.down(10, 400)
    b.move(10 + GESTURE_SLOP_PX, 400)
    b.uninstall()
    b.uninstall()
    b.move(10 + GESTURE_DISTANCE_PX, 400)
    expect(b.toggles).toBe(0)
  })

  it('drives an explicit event target when one is given', () => {
    const target = new EventTarget()
    const toggleSidebar = vi.fn()
    const uninstall = installSidebarGestures({ isSidebarExpanded: () => false, toggleSidebar, target })
    const send = (type: string, x: number): void => {
      target.dispatchEvent(pointerEvent(type, x, 400))
    }
    send('pointerdown', 10)
    send('pointermove', 10 + GESTURE_SLOP_PX)
    send('pointermove', 10 + GESTURE_DISTANCE_PX)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
    uninstall()
    send('pointermove', 10 + GESTURE_DISTANCE_PX * 2)
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })
})