# Agent Note: Hand-declared pi-ai models get the canonical reasoning fallback set

Status: implemented

English | [中文](2026-08-19-pi-ai-canonical-fallback-reasoning-levels.zh.md)

## Problem

A hand-declared pi-ai model whose entry names no `reasoningEfforts` — the common shape for a custom vendor — materialized with `reasoning: false`, so `getSupportedThinkingLevels` returned the single level `off` and the effort picker offered nothing. A custom vendor that reasons without reporting its levels therefore had no way to set a thinking level: the control was absent entirely, and any explicit pick the core could not map to a declared level failed the request.

## Decision

`resolveModelReasoning` reports the canonical fallback set (`off` / `low` / `high` / `max`) for a hand-declared model with no installed-catalog entry and no `reasoningEfforts`. The `thinkingLevelMap` pins every level explicitly — `low`/`high`/`max` carry their canonical spelling, `minimal`/`medium`/`xhigh` are `null` — so pi-ai's asymmetric absent-key defaulting (absent means supported for the base levels, unsupported for `xhigh`/`max`) cannot leak levels into the offer. `off` stays absent from the map, which pi-ai reads as "supported, send nothing": the standard not-thinking vocabulary. An installed catalog entry keeps describing its model, and `reasoningEfforts: false` keeps declaring a non-reasoning model with no picker.

The request path maps the canonical level best-effort through the profile's `thinkingFormat`; a vendor that refuses the parameter is handled by the request-time degradation in [[2026-08-19-normalize-unsupported-reasoning-efforts]] (Phase C).

## Alternatives considered

- **Gate the fallback behind a profile switch.** Rejected: the user's custom vendors reason without declaring levels, and the whole point is that the picker stays usable without per-model configuration; `reasoningEfforts: false` remains the explicit way to strip reasoning.
- **Keep reporting the capability unavailable.** Rejected: it leaves the thinking control absent for exactly the models the user needs it on.

## Consequences

The composer and `/model` popup offer `off`/`low`/`high`/`max` for any hand-declared custom model, and selecting a level sends it best-effort on the wire. Catalog models and explicitly non-reasoning models are unchanged. The pi-ai README and `reasoningInfo` JSDoc now describe the fallback set instead of the old "hand-declared models do not reason" rule.
