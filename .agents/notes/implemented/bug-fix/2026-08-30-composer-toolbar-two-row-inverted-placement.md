# Agent Note: Two-row composer toolbar rendered the groups on inverted rows

Status: implemented

English | [中文](2026-08-30-composer-toolbar-two-row-inverted-placement.zh.md)

## Problem

The nesting fix ([two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.md)) restored the two flex siblings, but the shipped arrangement came out inverted: on a phone the trailing group (model seat, context ring, primary action) rendered on the **top** row and the tools group (attach/access/plan) on the **bottom** row — the opposite of the intended "primary actions sink to the bottom row, filled first, right-aligned with send rightmost". The nesting-fix note's own verification numbers already showed it (trailing top 515 above tools top 555) and were read as success.

Root cause: `.tools { order: -1 }` was applied at every width, and `order` decides line packing order. Under `flex-wrap: wrap-reverse` the tools group therefore packed into the **first** flex line, and `wrap-reverse` places the first line at the cross-end — the bottom. Narrow single-row rendering needed `order: -1` for the tools-left visual order, which is why it was global, but that same value inverted the two-row assignment.

## Decision

Give each width the mechanism that width needs, in `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` only (no DOM change; the trailing group still precedes tools in JSX):

- Narrow (`@media (max-width: 640px)`): `.row` becomes `flex-direction: row-reverse` + `flex-wrap: wrap-reverse`, `.tools` resets to `order: 0` and pins itself left with `margin-right: auto`, and `.trailing` drops its wide-value `margin-left: auto`. Row-reverse puts the DOM-first trailing group at the main-start (right) edge; wrap-reverse sinks the first packed line — trailing, now that tools' order reset restores DOM packing order; the auto margin pins tools to the left edge on its own line. The same pairing keeps a single row tools-left, trailing-right, so narrow single-row no longer depends on `order` at all.
- Wide (>640px): unchanged — `.tools { order: -1 }` plus `space-between` and trailing's auto margin.

A dead `row-gap: 8px` declaration (always overridden by the following `gap` shorthand) was removed in the same block.

## Verification

Playwright against the real compiled CSS extracted from the rebuilt `lib/client.js` bundle, at 900/500/320 px viewports with representative control widths:

- 320px (splits): tools on the **top** row left-aligned (x=8, y=52); trailing on the **bottom** row (y=86) right-aligned to the card edge (right=312), send rightmost and model leftmost within the group.
- 500px (fits): single row, tools left (x=8), trailing right (right=492).
- 900px (wide): single row, tools left, trailing right — identical arrangement to narrow single-row.

`input-bar.client.spec.tsx` 72/72, `tsc --noEmit` and oxlint clean.

## Alternatives considered

**Scope `order: -1` to wide viewports and keep plain `row` + `wrap-reverse` narrow.** Rejected — narrow single-row then renders trailing left / tools right (the wide flip is gone exactly where the phone needs it), and no margin arrangement can recover tools-left/trailing-right from the DOM order `[trailing, tools]` on one line without `order` or a reversed main axis.

**Per-control wrapping instead of per-group.** Rejected — the requirement is group-level: the primary group fills the bottom row first; individual controls never interleave across rows.

## Consequences

The toolbar now matches the confirmed requirement at every width: one row keeps the current arrangement; two rows put the primary group on the bottom, right-aligned with send rightmost, and the tools on the top, left-aligned. Wide layouts and the DOM/tab order are unchanged; the change is CSS-only, so no seat, dispatch, or accessibility contract moved.

## Related

- [Two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.md) — restored the two flex siblings this note's CSS corrects; its mechanism paragraph describes the pre-fix `order: -1` arrangement that inverted the rows.
- [Mobile composer toolbar single-row and model menu](../feature/2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.md) — the narrow-viewport toolbar rules both fixes build on.
