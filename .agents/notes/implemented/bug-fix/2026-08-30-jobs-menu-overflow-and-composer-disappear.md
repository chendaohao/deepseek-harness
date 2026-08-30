# Agent Note: Background-job menu overflows on phones; composer disappears during tasks

Status: implemented

English | [中文](2026-08-30-jobs-menu-overflow-and-composer-disappear.zh.md)

## Problem

Two mobile-only defects in the session header and composer while background jobs run:

1. **The job-list menu overflows the viewport.** `JobListAction`'s popover is `position: absolute; left: 0` relative to its trigger, which sits on the header's actions line. On phones the trigger can sit near the right edge, so the 336px menu spilled past the right edge (e.g. trigger at left 152 in a 402px viewport put the menu at right 488 — 86px off-screen), making the list look unopenable.

2. **The composer disappears during a running task and only a page refresh restores it.** Not yet root-caused: the composer (sticky seat) stays visible in Playwright probes while jobs run, scroll, or sessions switch; the reporter observes it vanish mid-task on the phone. Candidate mechanisms under investigation: the `settling` composer-hide path (`openState === 'loading'` with a non-summary-blank session), the `ui-approval` `ApprovalPanel` takeover (`pendingInteraction` stuck), or the `ui-subagent` read-only composer takeover for one-shot/continuable sessions.

## Decision

1. **Center the job menu on its trigger on narrow viewports**, mirroring the model-select menu's posture: under `@media (max-width: 640px)`, `.menu { left: 50%; transform: translateX(-50%) }`. The existing `max-width: min(400px, calc(100vw - 32px))` keeps it inside the viewport at every phone width.

2. **Do not clip the popover with the actions-line shrink.** The first implementation gave `.headerActions { overflow: hidden }` under the narrow breakpoint to contain the shrinking badge/job trigger; that also clipped the absolutely-positioned job menu (which paints below the header line) so its 10 rows were present in the DOM but never painted. The overflow is removed; `min-width: 0` on the actions and their children already keeps the line shrinking without clipping popovers.

3. **Center the context-occupancy panel on the viewport on narrow viewports.** The `ContextMeter` panel is `position: absolute; right: 0` to its 28px ring root, which sits beside the send button near the row's end — a 264px panel right-anchored there overflows the viewport's left edge. Under the 640px breakpoint the panel becomes `position: fixed; left: 50%; transform: translateX(-50%); bottom: 120px`: the fixed positioning resolves the 50% against the viewport (not the 28px root, where percentage centering is meaningless), placing the panel dead-center above the composer at every phone width.

4. **Composer disappearance: deferred pending root cause.** Recorded here so the next session continues from the candidate list above instead of re-investigating from scratch.

## Verification

Playwright against the real GUI through the mobile-preview proxy, session with 10 live jobs:

- 402px vw: job menu left 20-356, center 188 == trigger center 188, fully inside the viewport; `elementFromPoint` at menu content hits the menu's `li` (content actually painted and clickable).
- 340px vw: job menu left 15-323, center == trigger center, fully inside the viewport, content hit-testable.
- 392px vw: context panel left 64-328, centered on the viewport (center diff <= 2px), fully inside the viewport, content hit-testable; 340px vw: left 38-302, viewport-centered, inside.
- 1270px vw: context panel keeps `position: absolute; right: 0` alignment to its trigger; job menu left-anchored — desktop unchanged.
- Composer visibility sampled every 2s for 30s while jobs run, across scroll positions (top/middle/bottom) and across session switches: seat stays visible (`visibility: visible`, card top 779) — the disappearing case was not reproduced in these probes.
- `packages/client/ui-conversation/tests` + `packages/client/ui-jobs/tests`: 357/357 pass.

## Alternatives considered

**Keep the menu left-anchored and rely on `max-width`.** Rejected — the 336px width minus the 32px viewport margin still overflows whenever the trigger sits past ~34px from the right edge, which is the common case on the header's actions line.

**Clamp the menu with `right: 8px; left: auto` on narrow viewports.** Rejected — right-anchoring pins the menu's right edge to the viewport but visually detaches it from a trigger that sits mid-row; centering on the trigger (the model-menu convention) keeps the anchor relationship.

**Center the context panel with percentage math on the 28px ring root (`left: max(12px, min(calc(50% - 132px), calc(100vw - 276px)))`).** Rejected — percentages resolve against the 28px root, so the centering term collapses to a constant clamp and the panel still overflows for a ring near the right edge; only `position: fixed` makes the 50% resolve against the viewport.

## Consequences

The job menu opens centered under its trigger and its rows are actually painted and clickable at every phone width; the context panel opens dead-center above the composer and never overflows. Desktop keeps both surfaces' original anchored placement. The composer-disappearance defect remains open with a documented candidate list; a fix lands in a follow-up change.

## Related

- [Session-header controls overlap on phone widths](2026-08-30-session-header-narrow-overlap-fix.md) — the header actions-line layout this menu anchors to; the same 640px breakpoint convention.
