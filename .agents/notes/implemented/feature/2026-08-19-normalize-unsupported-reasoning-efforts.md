# Agent Note: Unsupported reasoning efforts normalize to the model default

Status: implemented

English | [中文](2026-08-19-normalize-unsupported-reasoning-efforts.zh.md)

## Problem

The composer's effort picker and the `/model` popup select an adapter-owned reasoning effort per model. A custom model vendor often does not declare its thinking levels (`reasoningEfforts` absent on a hand-declared pi-ai route) and does not echo which level it actually applied, so the harness's only signal is the request itself. Selecting an effort the model does not declare was rejected with `UNSUPPORTED_REASONING_EFFORT` before provider I/O — the selection failed with a toast and the request never went out. For a vendor that reasons but never reports its levels, that made the thinking-level control unusable: undeclared models offered no picker, and any explicit pick the catalog had not caught up with failed outright.

## Decision

`LlmRuntime.resolveCallFor` — the single resolution point shared by `selectModel` and `prepareCall` — normalizes an explicit effort the model does not offer instead of rejecting it. The fallback chain is: the requested effort → the model's adapter-owned `defaultEffort` when one is declared → dropping the effort so the provider's own default applies. The config is never aliased to an arbitrary level; the resolution only ever lands on a level the adapter declared, or none.

This is a targeted relaxation of the "never clamp or alias" rule in [[2026-07-24-adapter-owned-reasoning-effort-capabilities]]. The adapter still owns its wire vocabulary: the core normalizes an effort outside the model's declared set before the adapter sees it, while each adapter keeps rejecting a level it cannot spell on the wire.

## Alternatives considered

- **Keep rejecting unsupported efforts.** Rejected: a custom vendor that reasons without declaring its levels could never use the thinking-level control; every optimistic or stale pick failed the whole selection.
- **Normalize only for models that declare no reasoning.** Rejected because it splits resolution semantics by capability shape — a catalog model whose entry lags its real levels deserves the same fallback as a hand-declared one.

## Consequences

`selectModel` and `prepareCall` resolve to the normalized effort (or none) instead of failing, and the `request/header` logs that resolved value, keeping the model-visible request reconstructable. A `thinking: disabled` DeepSeek deployment offers only `off`, so an explicit higher effort normalizes to it and the request still disables thinking. Tests that asserted the rejection are updated to assert the fallback chain; the client compares the requested and resolved effort to surface the normalization.
