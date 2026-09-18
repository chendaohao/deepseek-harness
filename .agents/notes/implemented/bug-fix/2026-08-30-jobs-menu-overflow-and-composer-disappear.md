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

3. **Keep the context-occupancy panel inside the viewport on narrow viewports.** The `ContextMeter` panel is portaled to `document.body` and positioned by `useAnchoredPosition` from its 28px ring root (side `top`, gap 8, margin 12), which writes inline `left`/`top` and clamps both into the viewport on resize, scroll, and panel-size changes. That clamp is the whole mechanism: it keeps the 264px panel inside at every phone width, above the composer.

4. **The job menu is also pinned to the viewport center, not the trigger.** A trigger-centered menu still reads off-center against the viewport (the trigger sits mid-row): `@media (max-width: 640px)` gives `.menu { position: fixed; top: 120px; left: 50%; transform: translateX(-50%) }`, the same posture as the context panel.

5. **Composer disappearance: deferred pending root cause.** The reporter reproduced it while these UI changes were being rebuilt — i.e. along the client-HMR hot-swap path. `client-hmr` replaces the `ui-conversation` fiber (registry-first teardown, `entry.refresh()`), which unmounts and remounts the conversation slot; the vendor comment documents a dev-only race where a rebuilt frame overlapping an in-flight boot arrival can materialize pre-rebuild bytes, and an apply failure leaves a FAILED fiber with no composer until the next rebuilt frame or a page reload. The composer was NOT reproduced in Playwright probes (reloads, HMR rebuilds, session switches all keep `data-composer-card` visible, phase `active`). Candidate mechanisms recorded: the `settling` hide path (`openState === 'loading'` with a non-summary-blank session), the `ui-approval` `ApprovalPanel` takeover (`pendingInteraction` stuck), the `ui-subagent` read-only composer takeover, or an HMR fiber-swap failure leaving the conversation slot unmounted.

## Verification

Playwright against the real GUI through the mobile-preview proxy, session with 10 live jobs:

- 402px vw: job menu left 33-369 — `viewportCenterDiff: 0`, left/right gaps both 33px (perfect viewport centering), fully inside the viewport; `elementFromPoint` at menu content hits the menu's `li` (content actually painted and clickable).
- 365px vw: job menu left 16-349, viewport-centered (gaps 16/16), content hit-testable; 330px vw: left 16-314, viewport-centered.
- 390px vw: context panel x 114-378, y 724-866 (264x142), fully inside the 390x900 viewport with 12px kept on the anchored edge and no `transform` applied; 480px and 640px vw take the same path to the same 264x142 box.
- 1280px vw: context panel x 839-1103, y 724-866, clear of the viewport edges; job menu left-anchored — desktop unchanged.
- Composer visibility sampled every 2s for 30s while jobs run, across scroll positions (top/middle/bottom), across session switches, across a page reload, and across a client-HMR rebuild of `ui-conversation`: seat stays visible (`visibility: visible`, card top 779, phase `active`, zero console errors) — the disappearing case was not reproduced in these probes.
- `packages/client/ui-conversation/tests` + `packages/client/ui-jobs/tests`: 357/357 pass; `apps/web/tests/context-meter.e2e.ts`, which now owns the panel's viewport placement at 390/800/1280px: 2/2 pass.

## Alternatives considered

**Keep the menu left-anchored and rely on `max-width`.** Rejected — the 336px width minus the 32px viewport margin still overflows whenever the trigger sits past ~34px from the right edge, which is the common case on the header's actions line.

**Clamp the menu with `right: 8px; left: auto` on narrow viewports.** Rejected — right-anchoring pins the menu's right edge to the viewport but visually detaches it from a trigger that sits mid-row; centering on the trigger (the model-menu convention) keeps the anchor relationship.

**Center the context panel from CSS under a narrow breakpoint (`left: 50%; transform: translateX(-50%); bottom: 120px`).** Removed — the portaled panel already carries inline `left`/`top`, so the breakpoint's `left: 50%` lost the cascade while its `transform` still applied, shifting the panel half its own width off the anchor; `bottom` set against the inline `top` also over-constrained the resolved height, collapsing the 264px panel to its 24px padding so its content spilled over the composer. Measured at 390px vw with that block present: x = −18, height 24px.

## Consequences

The job menu opens centered under its trigger and its rows are actually painted and clickable at every phone width; the context panel opens above the composer and stays inside the viewport at every width. Desktop keeps both surfaces' original anchored placement. The composer-disappearance defect remains open with a documented candidate list; a fix lands in a follow-up change.

## Related

- [Session-header controls overlap on phone widths](2026-08-30-session-header-narrow-overlap-fix.md) — the header actions-line layout this menu anchors to; the same 640px breakpoint convention.
