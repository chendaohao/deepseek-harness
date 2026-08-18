# Agent Note: Turn footer drops decode throughput; StatsLine keeps it

Status: implemented

English | [中文](2026-08-18-turn-footer-drops-decode-throughput.zh.md)

## Problem

The turn speed metrics work displayed decode throughput twice: the turn footer's `MessageIconActions` appended `· 34 tok/s` after the run-duration figure, and StatsLine already renders the same throughput from the same step usage. The footer figure required folding provider usage across all steps of the turn, while the footer's other figures are latency readings of the settled turn alone. A duplicate figure with a dedicated fold is surface StatsLine already owns.

## Decision

The turn footer shows latency figures only — message clock, TTFT, and run duration. Decode throughput stays exclusively in StatsLine.

- `deriveTurnMetrics` folds TTFT only; the `tokensPerSecond` field leaves `TurnMetrics`, `TurnTailChatData`, and `MessageIconActions`, and `TurnTailNodeView`/`turn-tail.ts` stop wiring it.
- The dead `message.tokensPerSecond` locale key is deleted from both locales.
- `formatTokensPerSecond` and the `stats.tokensPerSecond` key remain, consumed by StatsLine.

## Alternatives considered

- **Keep the footer figure** — rejected: StatsLine already presents the same throughput, and the footer is the settled-turn summary; one figure, one home.
- **Move throughput out of StatsLine instead** — rejected: StatsLine is the conversation-stats surface; the footer has no counterpart for the per-turn decode window once the fold is gone.

## Consequences

Turn tails no longer render tok/s; users read decode throughput from StatsLine. The per-turn usage fold in `deriveTurnMetrics` is gone, so turn metrics no longer need step usage at all. Tests updated in the same change (turn-metrics spec and the chat snapshot fixture); no session-log or wire format change.
