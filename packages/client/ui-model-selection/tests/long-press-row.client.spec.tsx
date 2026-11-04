// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ECHO_WINDOW_MS, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, useRowGesture } from '../src/client/long-press-row.ts'

afterEach(cleanup)

/** One delegated container with two rows and a gap that is neither. */
function Harness({ onRow }: { onRow: (name: string) => void }) {
  const gesture = useRowGesture('[data-row]', (row) => { onRow(row.dataset['row'] ?? '') })
  return (
    <div data-testid="container" {...gesture}>
      <button type="button" data-row="first">First</button>
      <span data-testid="gap">gap</span>
      <button type="button" data-row="second">Second</button>
    </div>
  )
}

function setup(): { onRow: ReturnType<typeof vi.fn>; container: HTMLElement; row: (name: string) => HTMLElement } {
  const onRow = vi.fn()
  render(<Harness onRow={onRow} />)
  const container = screen.getByTestId('container')
  return { onRow, container, row: name => container.querySelector<HTMLElement>(`[data-row="${name}"]`)! }
}

/**
 * Dispatch one pointer event. jsdom has no `PointerEvent`, so a `MouseEvent`
 * carries the coordinates and the pointer type is defined onto it — the shape
 * React's delegated listener reads.
 */
function press(target: HTMLElement, type: string, pointerType: string, x = 0, y = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  fireEvent(target, event)
}

describe('useRowGesture long press', () => {
  it('fires after the hold and leaves nothing armed', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch')
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1) })
    expect(onRow).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onRow).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('cancels the hold when the pointer travels past the slop', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch', 0, 0)
    press(row('first'), 'pointermove', 'touch', 0, LONG_PRESS_SLOP_PX + 1)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).not.toHaveBeenCalled()
  })

  it('keeps the hold alive within the slop', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch', 0, 0)
    // Just inside the slop: a hand wobbles during an intentional hold.
    press(row('first'), 'pointermove', 'touch', 6, 6)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('ends the hold on pointerup and pointercancel', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch')
    fireEvent.pointerUp(row('first'))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    press(row('second'), 'pointerdown', 'touch')
    fireEvent.pointerCancel(row('second'))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).not.toHaveBeenCalled()
  })

  it('never arms on a mouse press, because the context menu owns that gesture', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'mouse')
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).not.toHaveBeenCalled()
  })

  it('never arms on a secondary button or a press that lands outside a row', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    fireEvent.pointerDown(row('first'), { button: 2, pointerType: 'touch' })
    press(screen.getByTestId('gap'), 'pointerdown', 'touch')
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).not.toHaveBeenCalled()
  })

  it('ignores a pointer move that no hold armed', () => {
    const { onRow, row } = setup()
    press(row('first'), 'pointermove', 'touch', 0, 100)
    expect(onRow).not.toHaveBeenCalled()
  })
})

describe('useRowGesture context menu', () => {
  it('activates on a context menu event, which is also how Shift+F10 and the ContextMenu key arrive', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    // The browser synthesizes `contextmenu` for both keyboard gestures, so the
    // delegated handler treats every source the same way.
    fireEvent.contextMenu(row('first'))
    expect(onRow).toHaveBeenCalledExactlyOnceWith('first')
    act(() => { vi.advanceTimersByTime(ECHO_WINDOW_MS) })
    fireEvent.contextMenu(row('second'))
    expect(onRow).toHaveBeenLastCalledWith('second')
  })

  it('suppresses the platform menu and ignores events outside a row', () => {
    const { onRow, row } = setup()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    row('first').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(onRow).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(screen.getByTestId('gap'))
    expect(onRow).toHaveBeenCalledTimes(1)
  })

  it('leaves the armed hold to its timer, then drops the context menu that press produces', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch')
    // Android reports the same press as a context menu while the hold is armed.
    fireEvent.contextMenu(row('first'))
    expect(onRow).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).toHaveBeenCalledExactlyOnceWith('first')
    // The press's own context menu and click are echoes, not a second activation.
    fireEvent.contextMenu(row('first'))
    fireEvent.click(row('first'))
    expect(onRow).toHaveBeenCalledTimes(1)
    // After the window, a fresh press owns its action again.
    act(() => { vi.advanceTimersByTime(ECHO_WINDOW_MS) })
    press(row('first'), 'pointerdown', 'mouse')
    fireEvent.contextMenu(row('first'))
    expect(onRow).toHaveBeenCalledTimes(2)
  })

  it('stops an armed hold on a different row before activating', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { onRow, row } = setup()
    press(row('first'), 'pointerdown', 'touch')
    fireEvent.contextMenu(row('second'))
    expect(onRow).toHaveBeenCalledExactlyOnceWith('second')
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    expect(onRow).toHaveBeenCalledTimes(1)
  })
})

describe('useRowGesture echo click', () => {
  it('passes an ordinary click straight through', () => {
    const { onRow, row } = setup()
    const click = vi.fn()
    row('first').addEventListener('click', click)
    fireEvent.click(row('first'))
    expect(click).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })

  it('swallows the click that ends a fired hold without reaching the row', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { row } = setup()
    const click = vi.fn()
    row('first').addEventListener('click', click)
    press(row('first'), 'pointerdown', 'touch')
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 1) })
    fireEvent.click(row('first'))
    expect(click).not.toHaveBeenCalled()
    // Only that one click is dropped, and the next need not wait out a window:
    // a deliberate click straight after the press still reaches the row.
    fireEvent.click(row('first'))
    expect(click).toHaveBeenCalledTimes(1)
  })
})
