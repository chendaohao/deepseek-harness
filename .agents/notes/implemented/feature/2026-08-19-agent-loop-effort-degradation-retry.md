# Agent Note: The built-in request-error fallback degrades a refused reasoning effort

Status: implemented

English | [中文](2026-08-19-agent-loop-effort-degradation-retry.zh.md)

## Problem

A request carrying an explicit reasoning effort that the provider refuses — a custom vendor rejecting the `reasoning_effort` parameter with a validation-class error — failed the whole turn: the built-in `agent/request-error` fallback could only retry the identical config, and a plugin-free deployment had nothing to change. The effort normalization in [[2026-08-19-normalize-unsupported-reasoning-efforts]] makes a selected level resolvable, but a vendor that rejects the parameter on the wire still stopped the conversation.

## Decision

The built-in `agent/request-error` fallback drops the reasoning effort once per step when the request carried one and the failure is a plausible effort rejection — `INVALID_REQUEST`/`HTTP_400`, or wording that names `reasoning`/`thinking`/`effort` — then retries. `RequestErrorAction` gains an optional `dropReasoningEffort`; the `agent/request` waterfall payload gains `degradedEffort` so a listener that re-injects an inherited effort (the model-selection middleware) skips it on the degraded retry. `buildRequest` strips the effort from its seed config as well, for deployments that mount no selection middleware. The degraded retry logs its own `request/header`, keeping the dropped parameter reconstructable.

The selection itself is untouched: the user's chosen effort stays on the session, only this retry omits it. A second failure surfaces the original error; the once-per-step bound prevents an infinite degrade loop.

## Alternatives considered

- **Retry inside the adapter.** Rejected: an adapter has no loop/session context to re-dispatch against, and folding a config change into a transport retry conflates the two concerns.
- **Retry the identical config.** The prior built-in fallback's only move; it cannot fix a parameter the provider refuses.

## Consequences

A plugin-free deployment completes a turn whose explicit effort the vendor rejected, by retrying on the provider's own default. The degraded retry is the last resort in the waterfall — a plugin that returns a recovery action still owns the retry. Tests cover the degrade path and the no-degrade path (a `RATE_LIMIT` is not an effort rejection).
