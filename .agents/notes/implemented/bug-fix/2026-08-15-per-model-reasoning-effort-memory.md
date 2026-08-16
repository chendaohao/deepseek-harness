# Agent Note: Explicit reasoning-effort choices are remembered per model route

Status: implemented

English | [中文](2026-08-15-per-model-reasoning-effort-memory.zh.md)

## Problem

The composer's effort picker and the /model popup named the model's `defaultEffort` explicitly on every model selection, and the host treated each selection as a complete statement. Switching models therefore always resolved the new route to its default and discarded the effort the user had explicitly chosen for the previous one; switching back presented the default again. An explicit choice was only ever the current selection, never a remembered preference, so "set once, use across switches" was impossible.

## Decision

Explicit effort choices are remembered per exact model route, durably in the `agent-default-model` Settings section as a `reasoningEfforts` map keyed by `provider/model`. The wire and host semantics split a selection's effort dimension into three states:

- A plain model switch (`session.selectModel` with no `reasoningEffort`) resolves the adapter default first, then re-resolves with the route's remembered effort when one exists and the model still offers it. A remembered level the route no longer offers falls back to the default and is dropped from the memory.
- An explicit level pick (with `reasoningEffort`) is validated and recorded for the resolved route.
- An explicit provider-default pick (`reasoningEffortExplicit: true` with no effort) clears the route's memory.

`AgentDefaultModelConfig` gained `rememberedEffort`, `rememberEffort`, and `forgetEffort`. Memory writes are best-effort like the default-selection save — a read-only settings provider must not make model switching fail — and `saveSelection` preserves the map because the default write replaces the whole section. Client surfaces no longer name the default effort on plain picks: the /model popup and the composer seat submit the route alone, while the effort pane marks its picks explicit so an omitted effort still means what it meant before.

This extends the [adapter-owned reasoning-effort capabilities](../../implemented/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) decision: the effort vocabulary stays adapter-owned and per-model; only the recollection of an explicit choice is host-owned now. The [headless default-selection entry](../../implemented/architecture/2026-08-09-headless-direct-core-entry-point.md) still owns the single process-wide default; the memory is an additional section field, not a second default.

## Alternatives considered

- **Carry the last chosen effort to models without a memory.** Rejected: effort is a per-model capability and models disagree about levels; applying the last choice across routes would silently select a level the user never chose for that model.
- **Client-only in-memory memory.** Rejected: a reload would lose every choice, and the host's default-selection save already persists the current selection; the Settings section is the existing durable seam.
- **Persist a per-model map inside the session.** Rejected: the session is per-conversation and the complaint spans sessions; the deployment-wide Settings section matches where the default selection already lives.

## Consequences

An explicit effort choice now survives model switches and reloads for the exact route it was made on, and each route keeps its own choice; switching to a route with no memory still presents that model's default. The `session.selectModel` payload gained one optional wire field (`reasoningEffortExplicit`). The effort memory is deployment-wide (shared by every session), which is the same scope as the existing default selection. A stale remembered level is self-healing: the host drops it on the next plain switch of that route.
