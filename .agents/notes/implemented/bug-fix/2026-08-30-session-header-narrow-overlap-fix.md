# Agent Note: Session-header controls overlap on phone widths

Status: implemented

English | [中文](2026-08-30-session-header-narrow-overlap-fix.zh.md)

## Problem

On phone-width viewports the conversation session header rendered its two fixed-width control groups in one flex row that overflowed: the title cluster (breadcrumb + mode badge + the background-job trigger from `ui-jobs`) and the Session-log button in `.headerUtilities` are both `flex: none`, so when the crumbs shrank to nothing the cluster's content (badge ~68px + job trigger ~100px) spilled over the utilities group. The job trigger ("N 个后台任务") and the Session-log button overlapped by ~56×28px, making the Session-log button unclickable under the job trigger.

## Decision

Under `@media (max-width: 640px)` (the same breakpoint the composer toolbar uses), stack the title row vertically: `.titleRow { flex-direction: column; align-items: flex-start }`, `.titleCluster { flex-wrap: wrap }`, and `.headerUtilities { margin-left: 0 }`. The cluster keeps its internal wrap so the badge and job trigger fold when they outgrow the cluster, and the utilities row (Session log) lands on its own line below — every control stays fully visible and clickable. Desktop (\>640px) keeps the original single-row layout untouched.

## Verification

Playwright against the real GUI through the mobile-preview proxy:

- 402px vw: job trigger (152-253, top 45-73) and Session-log button (76-193, top 79-111) no longer overlap (`overlapping: false`); header grows to 143px to hold the stacked rows.
- 1270px vw: `titleRowDirection` stays `row`, header height 76px, job trigger (556-657) and Session log (1075-1192) widely separated — desktop unchanged.
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` + `packages/client/ui-jobs/tests`: 94/94 pass.

## Alternatives considered

**Wrap the title row (`flex-wrap: wrap`) instead of stacking.** Rejected — the two groups' widths (131px cluster + 117px utilities) exactly fill the 248px row, so wrap never triggers; the overlap lives inside the cluster, whose own children overflow onto the utilities.

**Let the job trigger shrink (ellipsis/icon-only).** Rejected — the trigger is contributed by the `ui-jobs` plugin through the `conversation.session.header.actions` slot; shrinking it inside `ui-conversation` CSS couples the packages and does not help the mode badge that also overflows.

## Consequences

Phone-width sessions stack their header controls: title/badge row, background-job trigger, then Session log — each fully visible and clickable, at the cost of a taller header (~143px vs 76px) on narrow viewports. Desktop and tablet layouts are unchanged. The 94-test suites stay green.

## Related

- [Two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.md) — the same 640px breakpoint convention the composer toolbar uses; both fixes share the narrow-viewport layout regime.
