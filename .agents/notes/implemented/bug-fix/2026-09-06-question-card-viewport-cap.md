# Agent Note: question takeover cards cap at the measured scrollport

Status: implemented

English | [中文](2026-09-06-question-card-viewport-cap.zh.md)

## Problem

On a phone, the `ask_user_question` takeover card could present with its header (eyebrow, question title, minimize/close) clipped off the top of the screen: the first option row was cut mid-glyph directly under the conversation tabs, and the card appeared to float mid-column with dead space below it. The plan-review card shares the same geometry and the same failure mode.

The card caps at `max-height: min(60vh, 520px)` inside a sticky composer seat (`bottom: 0`) within the conversation scrollport. `vh` resolves against the largest viewport a phone browser can have (URL bar hidden, keyboard closed), not the live one, so the cap can promise more height than the column currently has — with the URL bar shown, a system font scale, or a taller stacked narrow header, the seat runs taller than the scrollport. A sticky element cannot leave its scrollport: the excess extends above the scroll edge, where scrolling cannot reach it, and clips the card header. The composer toolbar is `display: none` while a takeover is elected, so the strip below the clipped card is dead space with nothing to tap — which reads as "the dialog overflows and the bottom bar stopped responding" at the same time.

## Decision

**The takeover card's `max-height` gains a term measured from the live scrollport, and that term wins whenever the viewport-unit terms disagree with reality.** Both `QuestionComposer.module.css` and `PlanReviewPanel.module.css` cap at

```css
max-height: min(
  60vh,
  520px,
  calc(var(--dsh-conversation-viewport-height, 100dvh) - 16px)
);
```

`--dsh-conversation-viewport-height` is the scrollport `clientHeight` that `ConversationRoot` already publishes on the scroller (the same variable `TurnNavigator` consumes); `100dvh` carries the first paint before its observer fires, and `16px` is the frame's own vertical padding (6px top + 10px bottom). The card therefore never exceeds the space the sticky seat actually has, on any dynamic-viewport condition: URL bar transitions, keyboard resize modes, split screen, or a `vh`/ICB mismatch. The `60vh` and `520px` terms keep their existing role as the aesthetic caps on normal screens; the measured term only governs when the column is genuinely cramped.

## Alternatives considered

**Switch the aesthetic terms to `dvh`/`svh`.** Rejected as the sole fix: `dvh` resizes live as mobile toolbars hide and show (relayout on every toolbar transition), and `svh` still guesses at the live column height instead of measuring it. Both remain wrong wherever the real constraint is the conversation column — header height and rail width — rather than the viewport.

**Cap the sticky seat instead of the card.** Rejected: the seat is the shared ancestor of the fallback composer and every elected takeover, and its height is content-driven; a cap there needs the same variable anyway while coupling an ownership boundary (the seat is `ui-conversation`'s) to one consumer's card.

**Hide the overflow with `overflow: hidden` on the frame.** Rejected — that is the bug: the card already hides overflow, which is exactly why the header disappears silently instead of the layout failing loud.

## Consequences

The takeover card always presents its header and its footer actions inside the visible column, with the option list (or plan body) scrolling internally, on phones as on desktop. The dead strip below a clipped card is gone: the seat pins flush to the column floor, so the space the composer vacates while a question pends is bounded and obviously part of the takeover surface. The composer toolbar remaining hidden while a question is pending is the existing takeover design and is unchanged; the tap-to-show tooltips on that toolbar (3-second coarse-pointer dismissal) are unaffected and return as soon as the takeover resolves.

## Testing

`apps/web/tests/question-composer.e2e.ts` adds a phone-geometry block to the round-trip scenario: at a 360px column the takeover frame (`[data-question-key]` — card plus its 16px of frame padding) is polled to settle at or below the live scrollport at a 300px-tall viewport (where the measured term governs over `60vh`), and the title plus footer pager are polled visible at 520px. The assertion fails against the viewport-unit-only cap. Verified: `DSH_SNAPSHOT=replay npx vitest run --config vitest.web.config.ts apps/web/tests/question-composer.e2e.ts` (4 passed); `npx vitest run packages/client/ui-user-questions packages/client/ui-primitives/tests/tooltip.client.spec.tsx` (72 passed). Live probes at 360×300/520/740 with a two-question batch show the card capped (174px / 312px / 444px) with header and footer on screen at every size.
