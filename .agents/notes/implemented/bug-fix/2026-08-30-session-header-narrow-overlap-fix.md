# Agent Note: Session-header controls overlap on phone widths

Status: implemented

English | [中文](2026-08-30-session-header-narrow-overlap-fix.zh.md)

## Problem

On phone-width viewports the conversation session header rendered its two fixed-width control groups in one flex row that overflowed: the title cluster (breadcrumb + mode badge + the background-job trigger from `ui-jobs`) and the Session-log button in `.headerUtilities` are both `flex: none`, so when the crumbs shrank to nothing the cluster's content (badge ~68px + job trigger ~100px) spilled over the utilities group. The job trigger ("N 个后台任务") and the Session-log button overlapped by ~56×28px, making the Session-log button unclickable under the job trigger.

## Decision

Under `@media (max-width: 640px)` (the same breakpoint the composer toolbar uses), the title row stacks into two lines with the session title on its own line and the three controls — mode badge (`ui-agent-preset` label), background-job trigger (`ui-jobs`), and the Session-log button (`session-log-export`) — sharing the actions line below it:

- `ConversationSession.tsx` moves `headerActions` out of `titleCluster` into a new `.actionsRow` sibling that also holds `headerUtilities`; `.titleRow { flex-direction: column }` stacks title above actions on narrow viewports while desktop keeps both in one row.
- Every control participates in flex sizing on the actions line: the badge keeps its full preset name (`flex: 0 0 auto` under the narrow breakpoint, so "PTC 模式" never ellipsizes), the job count compresses, and the Session-log button sheds its minimum width (`min-width: 0` + label ellipsis). Nothing wraps or overflows on the actions line at any phone width.

The row's flex distribution was later corrected so the crumbs cannot squeeze the controls: `.titleCluster` is content-sized (`flex: 0 1 auto`, it takes the squeeze and its crumbs ellipsize) while `.actionsRow` keeps the slack without shrinking (`flex: 1 0 auto`), and the narrow breakpoint pins the actions line (`flex: none`) so the three controls never compress away under a long crumb.

Desktop (\>640px) keeps the original one-row layout untouched.

## Verification

Playwright against the real GUI through the mobile-preview proxy, session header with 10 live jobs:

- 402-310px vw sweep: crumb (title) keeps its full 170px width on its own line; the badge keeps its full 68px preset name ("PTC 模式", `truncated: false` at every width); job trigger (72→15px) and Session log (92→57px) absorb the squeeze on the actions line with `overlapping: false` at every width; header height 110px (two lines).
- 1270px vw: `titleRowDirection` stays `row`, header height 76px, crumb (300-470), job trigger (822-930), and Session log (1075-1192) on one line — desktop unchanged.
- `packages/client/ui-conversation/tests`: 335/335 pass.

## Alternatives considered

**Stack every control on its own line (`titleRow { flex-direction: column }` with the cluster wrapping internally).** Rejected — it works but wastes vertical space (header ~143px): the three controls fit comfortably on one shared line once the badge and job trigger shrink, which the final design does.

**Keep the cluster containing the actions and only shrink it in place.** Rejected — the cluster's `flex: 1` absorbs all shrink pressure first, so the Session-log utilities never compress and the job trigger collapses to an ellipsis; moving the actions out of the cluster onto a shared line with the utilities lets flex distribute the available width across all three controls.

**Let the job trigger shrink (ellipsis/icon-only) inside `ui-conversation` CSS.** Rejected — the trigger is contributed by the `ui-jobs` plugin through the `conversation.session.header.actions` slot; shrinking it inside `ui-conversation` CSS couples the packages and does not help the mode badge that also overflows.

## Consequences

Phone-width sessions show the full session title on its own line, with the mode badge, background-job trigger, and Session-log button sharing one compressible line below — every control fully visible and clickable at 330px and wider, at the cost of a two-line header (~110px vs 76px) on narrow viewports. Desktop and tablet layouts are unchanged. The 335-test ui-conversation suite stays green.

## Related

- [Two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.md) — the same 640px breakpoint convention the composer toolbar uses; both fixes share the narrow-viewport layout regime.
