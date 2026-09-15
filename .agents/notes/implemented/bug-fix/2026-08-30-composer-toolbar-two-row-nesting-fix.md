# Agent Note: Two-row composer toolbar splits on the wrong nesting

Status: implemented

English | [中文](2026-08-30-composer-toolbar-two-row-nesting-fix.zh.md)

## Problem

The two-row composer toolbar fix (2026-08-30, "two-row composer toolbar puts the primary actions on the bottom row") intended the narrow-viewport composer toolbar to split into two rows: the trailing group (model seat, context ring, primary action) sinks to the bottom row, filled first and right-aligned with send rightmost, while the tools group (attach/access/plan) takes the top row. The mechanism is a flex container whose direct children are the trailing group followed by the tools group, with `flex-wrap: wrap-reverse` on the row and `order: -1` on tools: `wrap-reverse` sinks the first child (trailing) to the bottom line and lifts the second (tools) to the top line, while `order: -1` restores the single-row visual order (tools left, trailing right).

The implementation rendered `<div className={css.tools}>` **inside** `<div className={css.trailing}>` instead of as a sibling of it, so the row had exactly one flex child. `wrap-reverse` and `order: -1` both need two sibling children to act on; with one child the toolbar never split — every phone width rendered one row with the tools group nested inside the trailing group.

## Decision

Move the tools group out of the trailing group so both are direct children of the row container, matching the CSS mechanism the commit describes. `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` only; no CSS change.

## Verification

Playwright against the real GUI through the mobile-preview proxy (viewports swept at 412/375/360/340/320/300 device px):

- `row` has two direct children (`trailing`, `tools`) after the fix; before, `row` had one child and `tools` was nested in `trailing`.
- Single-row widths (402-330 vw): tools left (81-159), trailing right (222-369), send rightmost — the `order: -1` flip works.
- Split widths (310/290 vw): row height grows 42→76px and the toolbar splits, but the split landed **inverted** — trailing rendered above tools (top 515 vs 555), read as success at the time; corrected by [the inverted-placement fix](2026-08-30-composer-toolbar-two-row-inverted-placement.md).
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`: 72/72 pass.

## Alternatives considered

**Keep the tools group inside the trailing group and accept the single row.** Rejected — this is the buggy shipped state: the toolbar never splits on any phone width, and the commit's own mechanism (two flex siblings, `wrap-reverse`, `order: -1`) is dead code that misleads the next reader into thinking the split works.

**Restore the pre-merge single-row rules instead of the two-row split.** Rejected — the two-row split is the intended direction (the 2026-08-30 fix describes it as the fix for narrow viewports), and it works once the nesting is corrected; reverting to always-single-row would discard the shipped intent.

## Consequences

The narrow-viewport toolbar splits into two rows, but with the global `order: -1` this commit shipped, the groups landed on inverted rows — the mechanism paragraph above describes the intended, not the shipped, assignment. [The inverted-placement fix](2026-08-30-composer-toolbar-two-row-inverted-placement.md) corrects the row assignment with `row-reverse` + `wrap-reverse` and an order reset at narrow widths; the nesting fix itself (two direct siblings of the row) remains current. Desktop and wide mobile layouts are unchanged (the `@media (max-width: 640px)` block only applies below the breakpoint). The 72-test input-bar suite stays green, so no seat dispatch, ordering, or accessibility contract changed.

## Related

- [Two-row composer toolbar rendered the groups on inverted rows](2026-08-30-composer-toolbar-two-row-inverted-placement.md) — corrects the row assignment this commit's CSS mechanism produced; the sibling-structure fix recorded here remains current.
- [Mobile composer toolbar single-row and model menu](../feature/2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.md) — the narrow-viewport toolbar rules this commit's CSS extends; the merge re-application note records the post-0.1.2 structure the two-row split builds on.
