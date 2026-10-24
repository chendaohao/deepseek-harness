/** Anchor-preserving tooltips; an optional body portal escapes clipping containers and stacking contexts that cap the bubble's z-index. */

import { cloneElement, createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, MutableRefObject, PointerEventHandler, ReactElement, Ref } from 'react'
import { createPortal } from 'react-dom'
import { ShortcutKeys } from './ShortcutKeys.tsx'
import { placeTooltip, type TooltipSide } from './tooltip-placement.ts'
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.ts'
import css from './Tooltip.module.css'
// Tooltips take the wide answer — any key returns to the keyboard. Focus rings read the
// narrower `data-input-modality` attribute the same module publishes.
import { pointerModality } from './input-modality.ts'

export type { TooltipSide } from './tooltip-placement.ts'

/**
 * Suppression channel for nested tooltips: a visible descendant tooltip
 * withdraws the enclosing tooltip while its bubble is shown.
 */
export const TooltipSuppression = createContext<((suppressed: boolean) => void) | null>(null)

/** Props Tooltip injects into its anchor child; the child's own handlers are chained ahead of the tooltip's. */
interface AnchorProps {
  'aria-describedby'?: string | undefined
  ref?: Ref<HTMLElement> | undefined
  onPointerEnter?: PointerEventHandler | undefined
  onPointerLeave?: PointerEventHandler | undefined
  onPointerDown?: PointerEventHandler | undefined
  // The mouse pair remains the entry path for hardware that reports no pointer
  // events; a touch pointer withdraws it for the anchor it landed on.
  onMouseEnter?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onClick?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

type TooltipLabel = string | (() => string)

function clipped(anchor: HTMLElement): boolean {
  return [anchor, ...anchor.querySelectorAll<HTMLElement>('*')]
    .some(el => el instanceof HTMLElement && el.scrollWidth > el.clientWidth)
}

/**
 * Attach a hover/focus tooltip to an anchor element.
 * @param props.label - bubble text, or a resolver evaluated only while visible; an empty string shows only shortcut keys.
 * @param props.shortcutKeys - effective key labels rendered as platform-formatted keycaps after optional text.
 * @param props.side - preferred placement (default 'right'); fitting tries the opposite then perpendicular sides.
 * @param props.align - horizontal anchor-edge alignment for 'bottom'/'top' bubbles: 'end' pins
 * the bubble's right edge to the anchor's (for anchors beside other hover surfaces the centered
 * bubble would overlap); default 'center'. Horizontal placements ignore it.
 * @param props.portal - render the bubble under document.body, so an ancestor's clipping or its
 * stacking context (which confines the bubble's z-index to that context) cannot hide it.
 * @param props.delayMs - hover delay in milliseconds (default 0).
 * @param props.focusDelayMs - keyboard focus delay in milliseconds (default 0); blur, click,
 * mouse leave, disabling, and unmount cancel a pending show.
 * @param props.gap - anchor-to-bubble distance in pixels for 'bottom'/'top' bubbles (default 8);
 * horizontal placements use 10px, including after a flip.
 * @param props.disabled - suppress the bubble while true; the anchor renders identically so
 * toggling never remounts it (which would cut its CSS transitions).
 * @param props.maxWidth - bubble width cap in pixels, for labels long enough that the default
 * half-viewport cap would render a slab wider than the surface the anchor sits on; always bounded by viewport margins.
 * @param props.openOnClick - clicking or tapping also pins the bubble for reading; another click, Escape,
 * Tab, or an outside pointerdown dismisses it. Defaults to false for ordinary action tooltips.
 * @param props.onlyWhenClipped - show the bubble only when the anchor or an HTML element inside it
 * overflows horizontally, measured when the bubble is about to show; for labels that repeat
 * text an ellipsis may cut off. Defaults to false.
 * @param props.children - a single anchor element; its own ref (callback or object) is forwarded alongside the tooltip's.
 * @returns the cloned anchor plus a fixed-position bubble, optionally portaled to the body.
 * The bubble stays hidden until ResizeObserver supplies its size for viewport fitting; clicking the
 * anchor dismisses the bubble unless openOnClick is enabled, and focus arriving after a pointer
 * interaction (a closing menu refocusing its trigger) never raises it. Touch cannot trigger hover
 * tooltips; tapping still invokes the child's action and can open an openOnClick explanation.
 * When no side fits, the viewport-bounded fallback may overlap the anchor; oversized content is scrollable when pinned.
 */
export function Tooltip({ label, shortcutKeys, side = 'right', align = 'center', delayMs = 0, focusDelayMs = 0, gap = 8, disabled = false, portal = false, maxWidth, openOnClick = false, onlyWhenClipped = false, children }: { label: TooltipLabel; shortcutKeys?: readonly string[] | undefined; side?: TooltipSide; align?: 'center' | 'end'; delayMs?: number; focusDelayMs?: number; gap?: number; disabled?: boolean; portal?: boolean; maxWidth?: number; openOnClick?: boolean; onlyWhenClipped?: boolean; children: ReactElement<AnchorProps> }) {
  const id = useId()
  const [pinned, setPinned] = useState(false)
  const anchor = useRef<HTMLElement | null>(null)
  // React 18 keeps the element's ref outside props; forward it so wrapping an
  // anchor in Tooltip never silently severs the owner's ref.
  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = el
  }, [childRef])
  const [pos, setPos] = useState<DOMRect | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const resolvedLabel = pos === null
    ? null
    : typeof label === 'function' ? label() : label
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover and focus are independent triggers: the bubble hides only after
  // BOTH clear (hovering away from a focused anchor must not drop it).
  const triggers = useRef({ hover: false, focus: false })
  // Pointer type of the last entry that reached this anchor, so a touch press
  // can withdraw the compatibility mouse events the browser synthesizes after it.
  const lastPointer = useRef<string | undefined>(undefined)

  // Coarse primary inputs (touch) cannot hover away: a tap-triggered bubble
  // sticks open until the next tap elsewhere, so auto-dismiss it after a
  // short read period (mobile gets the label, then it clears itself).
  const COARSE_DISMISS_MS = 3000
  const coarse = useRef(typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: none)').matches
    : false)
  const coarseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelCoarse = useCallback(() => {
    if (coarseTimer.current === null) return
    clearTimeout(coarseTimer.current)
    coarseTimer.current = null
  }, [])

  // A nested tooltip's bubble owns the pointer position, so this tooltip
  // withdraws its own while a descendant shows one; the state below is set by
  // the descendants this tooltip wraps. Announcing on every visibility change
  // covers hide, disable, and unmount; show() also announces synchronously so
  // a nested pair shown in one commit never paints both bubbles.
  const suppressAncestors = useContext(TooltipSuppression)
  const [suppressed, setSuppressed] = useState(false)
  const announce = useCallback((active: boolean) => { suppressAncestors?.(active) }, [suppressAncestors])
  const visible = pos !== null && !disabled
  // ResizeObserver supplies the laid-out border box; fitting never reads
  // geometry after a position write or needs a React commit to flip sides.
  useEffect(() => {
    const el = bubble.current
    if (pos === null || !visible || suppressed || el === null) return
    let size: ResizeObserverSize | undefined
    let anchorRect = pos
    const fit = () => {
      if (size === undefined) return
      const placement = placeTooltip({
        anchor: anchorRect, width: size.inlineSize, height: size.blockSize,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, side, align, gap,
      })
      const horizontal = placement.side === 'right' || placement.side === 'left'
      const offsetX = horizontal ? 0 : align === 'end' ? placement.width : placement.width / 2
      const offsetY = horizontal ? placement.height / 2 : placement.side === 'top' ? placement.height : 0
      el.style.left = `${placement.left + offsetX}px`
      el.style.top = `${placement.top + offsetY}px`
      el.dataset.side = placement.side
      el.style.visibility = 'visible'
    }
    const onResize = () => {
      if (anchor.current !== null) anchorRect = anchor.current.getBoundingClientRect()
      fit()
    }
    const observer = new ResizeObserver((entries) => {
      size = entries[0]?.borderBoxSize[0]
      fit()
    })
    observer.observe(el, { box: 'border-box' })
    window.addEventListener('resize', onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [align, gap, pos, side, suppressed, visible])
  useEffect(() => {
    announce(visible)
    return () => { announce(false) }
  }, [announce, visible])

  // Disabling mid-hover (e.g. clicking a rail control expands the sidebar)
  // must drop an already-visible bubble: no mouseleave fires.
  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])
  useEffect(() => {
    if (pinned && (disabled || !openOnClick)) setPinned(false)
    if (disabled) {
      cancelShow()
      triggers.current = { hover: false, focus: false }
      setPos(null)
    }
    return () => { cancelShow(); cancelCoarse() }
  }, [cancelCoarse, cancelShow, disabled, openOnClick, pinned])

  const show = () => {
    if (disabled) return
    const el = anchor.current
    /* v8 ignore next -- the ref is attached by event time: events fire on the cloned anchor. */
    if (el === null) return
    if (onlyWhenClipped && !clipped(el)) return
    setPos(el.getBoundingClientRect())
    // Coarse devices arm the read-period dismiss; a mouse hover on a
    // hover-capable device leaves dismissal to leave/blur as before. Keyboard
    // focus is a fine-pointer modality and never auto-dismisses: the bubble
    // stays until blur, as a keyboard user cannot re-raise it by hovering.
    if (coarse.current && !triggers.current.focus) {
      cancelCoarse()
      coarseTimer.current = setTimeout(dismiss, COARSE_DISMISS_MS)
    }
    announce(true)
  }
  const showAfterDelay = (delay: number) => {
    cancelShow()
    if (delay <= 0) {
      show()
      return
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      show()
    }, delay)
  }
  const hide = () => {
    cancelShow()
    cancelCoarse()
    if (!triggers.current.hover && !triggers.current.focus && !pinned) withdraw()
  }
  const withdraw = useCallback(() => {
    setPinned(false)
    setPos(null)
    announce(false)
  }, [announce])
  const dismiss = useCallback(() => {
    cancelShow()
    cancelCoarse()
    triggers.current = { hover: false, focus: false }
    withdraw()
  }, [cancelCoarse, cancelShow, withdraw])
  useDismissOnOutsidePointer(anchor, openOnClick && visible, dismiss, bubble)
  useEffect(() => {
    if (!openOnClick || !visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
      dismiss()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [dismiss, openOnClick, visible])

  // A device crossing into coarse input (e.g. a foldable flipping to touch)
  // must not leave a hover bubble stranded: dismiss and re-evaluate.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(hover: none)')
    // A test double or a legacy MediaQueryList carries no change listener; the
    // initial `matches` read above still describes the device.
    if (typeof mq.addEventListener !== 'function') return
    const update = (): void => {
      coarse.current = mq.matches
      if (mq.matches) dismiss()
    }
    mq.addEventListener('change', update)
    return () => { mq.removeEventListener('change', update) }
  }, [dismiss])

  const content = visible && !suppressed && (
    <span
      ref={bubble}
      id={openOnClick ? id : undefined}
      className={css.bubble}
      data-side={side}
      data-portal={portal || undefined}
      data-pinned={pinned || undefined}
      data-align={align}
      data-has-shortcut={shortcutKeys?.length ? true : undefined}
      style={{ left: pos.left, top: pos.top, visibility: 'hidden', ...maxWidth === undefined ? {} : { maxWidth: `min(${maxWidth}px, calc(100vw - 24px))` } }}
      role="tooltip"
      aria-label={shortcutKeys?.length ? [resolvedLabel, shortcutKeys.join(' ')].filter(Boolean).join(' ') : undefined}
    >
      {resolvedLabel && <span className={css.label}>{resolvedLabel}</span>}
      {shortcutKeys !== undefined && shortcutKeys.length > 0 && <ShortcutKeys keys={shortcutKeys} variant="tooltip" />}
    </span>
  )

  return (
    <TooltipSuppression.Provider value={setSuppressed}>
      {cloneElement(children, {
        ref: mergedRef,
        'aria-describedby': openOnClick && visible
          ? [children.props['aria-describedby'], id].filter(Boolean).join(' ')
          : children.props['aria-describedby'],
        onPointerEnter: (e) => {
          children.props.onPointerEnter?.(e)
          lastPointer.current = e.pointerType
          if (e.pointerType === 'touch') return
          // iOS can emit mouse entry when a tapped control replaces its icon.
          if (e.pointerType === 'mouse' && !window.matchMedia('(any-hover: hover)').matches) return
          triggers.current.hover = true
          showAfterDelay(delayMs)
        },
        onPointerLeave: (e) => {
          children.props.onPointerLeave?.(e)
          lastPointer.current = e.pointerType
          triggers.current.hover = false
          cancelShow()
          if (!pinned) withdraw()
        },
        // Compatibility entry for hardware that reports no pointer events. The
        // mouse events a touch press synthesizes are ignored, so a tap can never
        // raise a hover bubble the device cannot dismiss.
        onMouseEnter: (e) => {
          children.props.onMouseEnter?.(e)
          if (lastPointer.current === 'touch') return
          triggers.current.hover = true
          showAfterDelay(delayMs)
        },
        onMouseLeave: (e) => {
          children.props.onMouseLeave?.(e)
          if (lastPointer.current === 'touch') return
          triggers.current.hover = false
          cancelShow()
          if (!pinned) withdraw()
        },
        onPointerDown: (e) => {
          children.props.onPointerDown?.(e)
          lastPointer.current = e.pointerType
          // A touch press withdraws a hover bubble the device cannot dismiss;
          // an openOnClick anchor repins on the click that follows.
          if (e.pointerType === 'touch') {
            if (!pinned) dismiss()
            return
          }
          // Coarse devices get the bubble on the press itself: a tap-triggered
          // mouseenter fires once (the first tap) — later taps on the same
          // anchor keep the sticky-hover state and never re-fire it, so
          // without this the bubble would stop showing after the first
          // auto-dismiss.
          if (openOnClick || !coarse.current) return
          triggers.current.hover = true
          cancelShow()
          show()
        },
        // Activating an ordinary action dismisses the bubble: it often changes
        // what the anchor now does (pin → unpin), and the click leaves the
        // anchor focused, which would otherwise pin the relabelled bubble up.
        onClick: (e) => {
          children.props.onClick?.(e)
          triggers.current.focus = false
          cancelShow()
          if (openOnClick && !disabled && !pinned) { setPinned(true); show() }
          else withdraw()
        },
        onFocus: (e) => {
          children.props.onFocus?.(e)
          if (pointerModality()) return
          triggers.current.focus = true
          showAfterDelay(focusDelayMs)
        },
        onBlur: (e) => { children.props.onBlur?.(e); triggers.current.focus = false; hide() },
      })}
      {portal ? (content !== false && createPortal(content, document.body)) : content}
    </TooltipSuppression.Provider>
  )
}
