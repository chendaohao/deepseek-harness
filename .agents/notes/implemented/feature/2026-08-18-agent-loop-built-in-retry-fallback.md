# Agent Note: Built-in retry fallback at the request-error waterfall

Status: implemented

English | [中文](2026-08-18-agent-loop-built-in-retry-fallback.zh.md)

## Problem

Retrying a failed model request required a plugin mounted on `agent/request-error`. With no listener, the waterfall's final `next()` default left every provider failure terminal, even when the adapter registration that served the request carried a resolved `retryPolicy`. A composition that mounts an adapter without recovery plugins therefore paid a failed turn for every transient provider error, where Claude Code retries transparently.

## Decision

The `agent/request-error` waterfall's built-in fallback — the `next()` tail that runs only when every listener delegated — applies the serving adapter's resolved retry policy directly:

- A request without a serving policy (`retryPolicy` undefined, e.g. it never reached a final adapter boundary) stays terminal.
- `mode: 'always'` retries every failure without an attempt limit, until success, cancellation, or agent disposal.
- Normal mode retries failures whose code is listed in `retryableCodes`, up to `maxRetries` (default 2) per step, then stays terminal.

A per-step retry counter resets each new step and increments only when the fallback itself decides to retry. `@deepseek-ai/dsh-llm-retry` — which runs earlier in the waterfall when mounted and can delegate downstream — keeps its own count through `llm/retry` session events, so its budget and the fallback's never share state. The fallback's retry re-attempts the same step immediately: no backoff, no `llm/retry` event, no turn closure. Failed chunks are non-surface and never enter the rebuilt request's derived messages.

## Alternatives considered

- **Leave the waterfall default terminal** (status quo) — rejected: retryability is policy the serving adapter already carries; refusing to execute it without a plugin turns every transient failure into a failed turn in minimal compositions.
- **Replicate the plugin's backoff and retry events in the loop** — rejected: `dsh-llm-retry` exists for deployments that want bounded exponential backoff, provider-respected delays, and durable retry history; duplicating it in the loop would split the retry budget between two counters with no shared history.

## Consequences

Minimal compositions recover from transient failures without a recovery plugin, matching Claude Code's transparent retry. The fallback writes no events of its own — each re-attempt's chunks stay trace/replay rows and the retried request is the ordinary model-visible request, so the model-visible ⟺ logged invariant is unchanged. `maxRetries` is a per-step budget: a multi-step turn spends a fresh budget on each step. Deployments that want backoff, retry events, or cross-deployment history still mount [dsh-llm-retry](2026-07-24-provider-retry-policies.md), which runs first and leaves the fallback unreached.
