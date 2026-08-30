# Agent Note: Background-job menu overflows on phones; composer disappears during tasks

Status: implemented

English | [中文](2026-08-30-jobs-menu-overflow-and-composer-disappear.zh.md)

## Problem

Two mobile-only defects in the session header and composer while background jobs run:

1. **The job-list menu overflows the viewport.** `JobListAction`'s popover is `position: absolute; left: 0` relative to its trigger, which sits on the header's actions line. On phones the trigger can sit near the right edge, so the 336px menu spilled past the right edge (e.g. trigger at left 152 in a 402px viewport put the menu at right 488 — 86px off-screen), making the list look unopenable.

2. **The composer disappears during a running task and only a page refresh restores it.** Not yet root-caused: the composer (sticky seat) stays visible in Playwright probes while jobs run, scroll, or sessions switch; the reporter observes it vanish mid-task on the phone. Candidate mechanisms under investigation: the `settling` composer-hide path (`openState === 'loading'` with a non-summary-blank session), the `ui-approval` `ApprovalPanel` takeover (`pendingInteraction` stuck), or the `ui-subagent` read-only composer takeover for one-shot/continuable sessions.

## Decision

1. **Center the job menu on its trigger on narrow viewports**, mirroring the model-select menu's posture: under `@media (max-width: 640px)`, `.menu { left: 50%; transform: translateX(-50%) }`. The existing `max-width: min(400px, calc(100vw - 32px))` keeps it inside the viewport at every phone width.

2. **Composer disappearance: deferred pending root cause.** Recorded here so the next session continues from the candidate list above instead of re-investigating from scratch.

## Verification

Playwright against the real GUI through the mobile-preview proxy, session with 10 live jobs:

- 402px vw: menu left 20-356, center 188 == trigger center 188, fully inside the viewport.
- 350px vw: menu left 13-331, center 172 == trigger center 172, fully inside the viewport.
- Composer visibility sampled every 2s for 30s while jobs run, across scroll positions (top/middle/bottom) and across session switches: seat stays visible (`visibility: visible`, card top 779) — the disappearing case was not reproduced in these probes.

## Alternatives considered

**Keep the menu left-anchored and rely on `max-width`.** Rejected — the 336px width minus the 32px viewport margin still overflows whenever the trigger sits past ~34px from the right edge, which is the common case on the header's actions line.

**Clamp the menu with `right: 8px; left: auto` on narrow viewports.** Rejected — right-anchoring pins the menu's right edge to the viewport but visually detaches it from a trigger that sits mid-row; centering on the trigger (the model-menu convention) keeps the anchor relationship.

## Consequences

The job menu now opens centered under its trigger and stays fully inside the viewport at every phone width, so the list is reachable on mobile. The composer-disappearance defect remains open with a documented candidate list; a fix lands in a follow-up change.

## Related

- [Session-header controls overlap on phone widths](2026-08-30-session-header-narrow-overlap-fix.md) — the header actions-line layout this menu anchors to; the same 640px breakpoint convention.
