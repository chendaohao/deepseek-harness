// @vitest-environment jsdom
/**
 * Document-scroll reset: the phone layer pins the app shell's document offset
 * to zero across every event the browser may move it on, coalesces the writes to
 * one frame, and removes every listener with the plugin fiber.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installViewportReset, type ViewportDocument, type ViewportWindow,
} from '../src/client/viewport.ts'

interface Bench {
  win: ViewportWindow
  doc: ViewportDocument
  scroller: { scrollTop: number; scrollLeft: number }
  viewport: { height: number } & EventTarget
  /** Run the callbacks queued by one or more reset triggers. */
  flush: () => void
  /** Callbacks still queued, unrun. */
  queued: () => number
  /** Run every timer the module armed (the resume settle window). */
  timers: () => void
}

/** A window stub carrying the document, a frame queue, a timer queue, and an optional visual viewport. */
function bench(options: { viewport?: boolean; height?: number } = {}): Bench {
  const frames: FrameRequestCallback[] = []
  const armed: Array<() => void> = []
  const scroller = { scrollTop: 0, scrollLeft: 0 }
  const doc = Object.assign(new EventTarget(), {
    scrollingElement: scroller,
    visibilityState: 'visible',
  }) as ViewportDocument & { visibilityState: string }
  const viewport = Object.assign(new EventTarget(), { height: options.height ?? 800 })
  const win = Object.assign(new EventTarget(), {
    document: doc,
    visualViewport: options.viewport === false ? undefined : viewport,
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      frames.push(callback)
      return frames.length
    },
    cancelAnimationFrame: (): void => { frames.length = 0 },
    setTimeout: (callback: () => void): number => {
      armed.push(callback)
      return armed.length
    },
    clearTimeout: (): void => { armed.length = 0 },
  }) as ViewportWindow
  return {
    win,
    doc,
    scroller,
    viewport,
    flush: () => { for (const callback of frames.splice(0)) callback(0) },
    queued: () => frames.length,
    timers: () => { for (const callback of armed.splice(0)) callback() },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installViewportReset', () => {
  it('pins both document axes to zero on a window resize', () => {
    const { win, scroller, flush } = bench()
    const stop = installViewportReset({ window: win, document: win.document })
    scroller.scrollTop = 120
    scroller.scrollLeft = 8
    win.dispatchEvent(new Event('resize'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    expect(scroller.scrollLeft).toBe(0)
    stop()
  })

  it('pins the offset when the page returns from the background', () => {
    const { win, doc, scroller, flush } = bench()
    const stop = installViewportReset({ window: win, document: doc })
    scroller.scrollTop = 400
    doc.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    // A hidden document is not reset: nothing is showing to correct.
    scroller.scrollTop = 400
    ;(doc as { visibilityState: string }).visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(scroller.scrollTop).toBe(400)
    stop()
  })

  it('follows the visual viewport as the address bar moves', () => {
    const { win, doc, scroller, flush } = bench()
    const viewport = win.visualViewport as EventTarget
    const stop = installViewportReset({ window: win, document: doc })
    scroller.scrollTop = 64
    viewport.dispatchEvent(new Event('scroll'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    scroller.scrollTop = 32
    viewport.dispatchEvent(new Event('resize'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('coalesces a burst of viewport reports into one frame', () => {
    const { win, doc, scroller, flush, queued } = bench()
    const viewport = win.visualViewport as EventTarget
    const stop = installViewportReset({ window: win, document: doc })
    scroller.scrollTop = 200
    viewport.dispatchEvent(new Event('scroll'))
    viewport.dispatchEvent(new Event('scroll'))
    viewport.dispatchEvent(new Event('scroll'))
    win.dispatchEvent(new Event('resize'))
    expect(queued()).toBe(1)
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('still guards the window when no visual viewport exists', () => {
    const { win, scroller, flush } = bench({ viewport: false })
    const stop = installViewportReset({ window: win, document: win.document })
    scroller.scrollTop = 90
    win.dispatchEvent(new Event('resize'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('resets on a pageshow restore', () => {
    const { win, scroller, flush } = bench()
    const stop = installViewportReset({ window: win, document: win.document })
    scroller.scrollTop = 300
    win.dispatchEvent(new Event('pageshow'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('stands down while a soft keyboard is up', () => {
    const { win, doc, scroller, flush, viewport } = bench({ height: 800 })
    const stop = installViewportReset({ window: win, document: doc })
    // The keyboard takes half the band; the browser deliberately scrolls the
    // document to keep the focused field visible and that offset must survive.
    viewport.height = 420
    scroller.scrollTop = 260
    win.dispatchEvent(new Event('resize'))
    flush()
    expect(scroller.scrollTop).toBe(260)
    // Keyboard closed: the next correction takes the offset back.
    viewport.height = 800
    win.dispatchEvent(new Event('resize'))
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('keeps sampling through the resume settle window', () => {
    const { win, doc, scroller, flush, timers } = bench()
    const stop = installViewportReset({ window: win, document: doc })
    // The browser restores its own offset a frame AFTER the resume event, so the
    // correction at event time has already run and lost that race.
    doc.dispatchEvent(new Event('visibilitychange'))
    flush()
    scroller.scrollTop = 180
    timers()
    flush()
    expect(scroller.scrollTop).toBe(0)
    stop()
  })

  it('stops resetting once disposed', () => {
    const { win, doc, scroller, flush, queued } = bench()
    const stop = installViewportReset({ window: win, document: doc })
    stop()
    scroller.scrollTop = 200
    win.dispatchEvent(new Event('resize'))
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(queued()).toBe(0)
    flush()
    expect(scroller.scrollTop).toBe(200)
    stop()
  })
})
