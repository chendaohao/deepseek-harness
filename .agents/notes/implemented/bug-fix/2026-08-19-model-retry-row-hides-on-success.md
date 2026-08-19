# Agent Note: model-retry notice hides once the retried step settles

Status: implemented

English | [中文](2026-08-19-model-retry-row-hides-on-success.zh.md)

## Problem

When a model request fails and `dsh-llm-retry` schedules a retry, the conversation shows a transient "Retrying model request (1/2)…" row (the `model-retry` node, rendered by `ModelRetryItem`). Its Definition matched only `llm/retry` and `llm/retry-started` and had no success convergence, so once materialized the row stayed in the transcript forever — even after the retried attempt produced the final answer.

## Decision

`model-retry` is a transient notice, not a durable record. In `retry.ts` `buildViewNode`, when the owning step's published `assistant-step` data is `status === 'settled'` (a completed final `assistant/message`, which after `resetForRetry` can only come from the retried attempt), return the node with `visibility: 'hidden'` — or `null` when the chain was never materialized in this window. This mirrors the `turn-error` node's suppression pattern ([node assembly](../architecture/2026-08-09-client-conversation-node-assembly.md)). No new wake-up mechanism is needed: the `step/end` location boundary already re-runs the retry context, and hidden nodes are dropped from the transcript `order` while staying materialized for timeline/branch stability.

`status === 'settled'` was chosen over `finalNode !== undefined` because the assistant Definition synthesizes an `interrupted` final node for aborted or errored streams — there the retry did not cleanly succeed, so the row stays visible as part of the interrupted-turn record.

## Alternatives considered

- **Hide on `finalNode !== undefined`** — rejected: interrupted streams also synthesize a final node, hiding a retry that did not cleanly succeed.
- **Key the retry node on (turn, step) and match `step/end` / `assistant/message` to wake it** — rejected: `match` is stateless, so every step would spawn a zombie context.
- **Add a `reader.previous('assistant-step')` dependency in `start` to hide one event earlier** — rejected: the assistant context revises on every chunk, replaying the retry context per token for a UX gain too small to notice.

## Consequences

- After a successful retry, the "Retrying…" row disappears at `step/end` and never reappears on history reload; retries that exhaust or are interrupted keep their visible row.
- Three new node-assembly tests cover the live hide, the history-reload absence, and the never-settled negative case; the existing failure-path test is unchanged.
