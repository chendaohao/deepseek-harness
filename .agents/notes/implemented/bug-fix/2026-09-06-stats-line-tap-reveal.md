# Agent Note: session stats strip reveals on tap for phones

Status: implemented

English | [中文](2026-09-06-stats-line-tap-reveal.zh.md)

## Problem

On a phone, the session stats strip under the composer ("1 轮 · 2 步 | LLM … | …") truncates to one line at the viewport floor, and the overflow — durations, token speeds, cache hit, billing — was unreachable: the strip's only expansion affordance was the shared hover Tooltip, whose touch path (tap → bubble → 3-second auto-dismiss, added in the 2026-08-18 touch-hygiene pass) does not fire on real handsets. In an instrumented mobile-Chromium session the tap's `pointerdown` reaches the strip's DOM element and React holds the cloned `onPointerDown` prop, yet React's delegated dispatch never runs it (a direct prop invocation shows the bubble; a trusted tap and a bubbling synthetic `PointerEvent` both do nothing, while `click` delegates fine — the + button's command menu opens from the same tap). Whatever the engine-level cause, the strip could not depend on it.

## Decision

**The strip owns its tap-to-read reveal locally, driven by `click`.** `StatsLineContent` wraps the strip in a positioning wrapper; when the line measures truncated, a tap expands the full line into a tooltip-styled panel anchored above the strip (`click`, not `pointerdown`, so the gesture rides the compatibility-event path every touch browser delivers), holds it for 3 seconds, and collapses; a second tap collapses immediately; a tap that arrives while expanded rearms the read period. The shared hover Tooltip stays for pointer users and is disabled while the panel is open. The panel reuses the Tooltip surface pair (`--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00`) so the two read as one affordance, spans the shared content-width axis (moved from `.root` to the wrapper), and wraps instead of clipping.

## Alternatives considered

**Fix the Tooltip's tap path instead.** Rejected for now: the failure survives every dispatch-level probe available in the harness (native listeners fire, propagation is intact, the container's delegated `pointerdown` listener is registered, no errors surface), so a fix would guess at a mechanism outside the repo's observability. The strip's own reveal needs none of it; if the engine-level cause is ever pinned down, the Tooltip fix remains worth doing for the composer toolbar's other tap tooltips.

**A Modal or floating panel for the full stats.** Rejected — the reading is transient glance support, not a surface: it must not take focus, block the composer, or add teardown obligations.

## Consequences

On phones, tapping the truncated stats strip shows the complete figures for 3 seconds and collapses; on desktop nothing changes visually (hover keeps the existing bubble; a click now also works as a click-to-hold read). The goldens are unaffected where the line is not truncated, because the wrapper only adds the interactive cursor and click handler when the strip measures truncated.

## Testing

A keyless replayed mobile run (360×740, touch, zh) drove a full ask_user_question round trip: tap → panel mounts with the full line, auto-collapses after the 3-second read period, a second tap re-expands, a third collapses immediately. `npx vitest run packages/client/ui-chat` (317 passed) and oxlint/tsc on the touched files stay green.

Follow-up fix from the same verification session: moving the sizing properties up left `.root` without its `box-sizing: border-box`, so its side paddings added 64px outside the wrap — on a phone column the strip's box poked past the chat scrollport, whose computed `overflow-x: auto` showed a horizontal scrollbar next to the vertical one. `.root` carries `box-sizing: border-box` again; a replayed probe at 360×740 confirms the scroller's `scrollWidth` returns to its `clientWidth` (296) once the strip renders.

## Related

- Commit 66bcd39185 (touch-device input hygiene, 2026-08-18) — the coarse-pointer tap-tooltip behavior (tap shows the bubble, 3-second auto-dismiss) this change stops relying on for the strip.
- [Question takeover cards cap at the measured scrollport](2026-09-06-question-card-viewport-cap.md) — the same mobile session's other finding: the takeover card overflow.
