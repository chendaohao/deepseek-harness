# Agent Note: Mobile composer toolbar fits one row; the model menu centers on its chip

Status: implemented

English | [中文](2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.zh.md)

## Problem

On phone-width viewports the composer toolbar rendered as two rows: the attach/access/plan group kept the first row while the model seat, context ring, and primary action wrapped to their own second row (the pre-existing `@media (max-width: 640px)` rule in `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` gave `.trailing` `flex: 1 1 100%`). Two independent defects made this worse and hard to fix:

- The restored-active-session composer carries the context-occupancy ring (`ContextMeter`, 28px) that the blank-session hero does not, so the trailing group is ~40px wider than any blank-session measurement shows — measuring only the hero state hides the overflow.
- The composer's own left app sidebar column (56px on phones) sits under any popover that expands leftward: the model-select menu anchored `right: 0` to its chip expanded left into that column and was partly covered.

## Decision

**The narrow-viewport toolbar keeps one row by not stretching and by tightening gaps.** In the `@media (max-width: 640px)` block: `.tools` changes from `flex: 1 1 auto` (which stretches and creates a false "big empty gap" between the permission chip and the model chip) to `flex: none`, and `.row`/`.tools`/`.trailing` gaps tighten (row 8px→6px, tools 8px→6px, trailing 6px→4px). The wrap stays as a safety valve for below-375px viewports.

**The model chip cap tightens so the whole trailing group fits.** `ModelSelect.module.css` `.trigger` `max-width` goes from `min(360px, 45cqw)` to `min(360px, 38cqw)`: wide rows still grant up to 360px, but a 390px phone's composer row (≈292px) caps the chip at ≈111px, letting the trailing group (model chip + context ring + primary) fit one row down to 375px viewports. Desktop is unaffected (a 778px row yields 38cqw ≈ 296px > the 168px the current model name needs).

**The model menu centers horizontally on its chip on narrow viewports.** `@media (max-width: 640px)` overrides `.menu` from `right: 0` to `left: 50%; transform: translateX(-50%)`, keeping `position: absolute; bottom: calc(100% + 8px)` so the menu stays directly above the chip, horizontally centered on it. A viewport-fixed full-screen centering (previous attempt: `position: fixed; left/top 50%; translate(-50%, -50%)`) was rejected because the menu visually detached from the composer to the screen middle.

## Alternatives considered

**Hide `ContextMeter` on narrow viewports.** Rejected — the user-visible fix must not remove a feature; the space exists once `.tools` stops stretching and gaps tighten.

**Keep `.tools` stretching and push the trailing group with `margin-left: auto`.** Rejected — this is exactly the pre-fix layout: the stretched tools group makes the gap between permission and model chips look huge while the trailing group still overflows and wraps.

**Center the model menu on the viewport (`position: fixed`, screen-middle vertical).** Rejected — "too high": the menu detached from its trigger to the screen center; the requirement is horizontal centering only, anchored to the chip.

## Consequences

Phones 375px and wider show the composer toolbar on one row in every session state (blank hero, active, restored-active), with the context ring intact; below 375px the wrap safety valve still splits to two rows. The model-select menu opens centered on its chip, clear of the left sidebar column, on every phone width; desktop keeps the original right-anchored placement. `pnpm run test:gui` stays green (4102 tests).

## Testing

`pnpm run test:gui` covers the client suites. The layout arms were verified in real Chromium via Playwright at 360/375/390/412/430/1280px: single-row `rowH: 42` with `sameLine` true from 375px up; the context ring present (28px) in restored-active sessions; the model menu neither covered by the 56px sidebar column nor overflowing the viewport at 375/390/412px; desktop (1280px) menu placement and model-chip width (168px) unchanged.

## Related

- [Narrow-viewport plan chip click-area regression test](../bug-fix/2026-08-06-plan-narrow-viewport-regression.md) — the existing composer control-row wrap mechanism (`flex-wrap: wrap` + `margin-left: auto`) this change builds on; the ≤640px default shifts from "wrap when space runs out" to "keep one row when possible", while the 760-850px wrap behavior is untouched.
