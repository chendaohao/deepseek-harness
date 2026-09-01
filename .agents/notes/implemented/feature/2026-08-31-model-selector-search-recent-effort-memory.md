# Agent Note: Composer model selector restores search/recent/collapse and gains per-route effort memory

Status: implemented

English | [中文](2026-08-31-model-selector-search-recent-effort-memory.zh.md)

This extends the [model selector search, recently-used, and collapsible providers](../../implemented/feature/2026-08-19-model-selector-search-recent-collapse.md) decision to the merged base and restores master's per-model reasoning-effort memory alongside it.

## Problem

The dev-workspace merge of upstream master (dsh 0.1.2-alpha.1) resolved the composer's model seat to master's flat provider-grouped list, dropping the branch's search box, recently-used section, and collapsible providers — the affordances the branch had built to scale the picker past one provider. The same merge also dropped master's per-model reasoning-effort memory (`reasoningEffortExplicit`): every model switch resolved the new route to its adapter default, discarding the effort the user had explicitly chosen for that route, and switching back presented the default again. The merged tree additionally carried dead CSS classes (`.search`, `.menuList`, `.groupToggle`, `.groupBadge`, `.groupChevron`) and orphaned locale keys (`search.placeholder`, `search.empty`, `recent.title`, `effort.normalized`).

## Decision

Restore both capabilities on the merged base.

**Search, recently-used, and collapsible providers return to the composer seat** exactly as the branch shipped them (the mobile remote sheet already kept them): a search box filters the catalog flat by model id/name or provider name through the shared `modelMatchesQuery`; a pinned recently-used section re-offers the last picks the current catalog still advertises, persisted per device in `localStorage` (key `dsh:recent-models`, capped at 6) via `useRecentModels`; each provider collapses under its own header with a model-count badge. Search, recent, and collapse state live entirely in the seat and reset per open. Keyboard behavior extends to the search field: ArrowDown enters the first option, Escape clears the query before backing out of the pane. The ARIA `role="menu"` stays valid by keeping the input outside it. Names-only rows stay names-only (the branch's `hide model selector descriptions` decision is unchanged); only the restored affordances and the effort toast reuse the previously orphaned keys.

**Per-route effort memory returns end to end.** `AgentDefaultModelConfig` gains `rememberedEffort` / `rememberEffort` / `forgetEffort` over a `reasoningEfforts` map in the `agent-default-model` settings section, keyed by `provider/model`; `saveSelection` preserves the map so a default write never drops other routes' choices. The `session.selectModel` payload gains one optional wire field, `reasoningEffortExplicit`. The host's `selectModel` command splits the effort dimension into three states: a plain switch (no effort) resolves the adapter default first, then re-resolves with the route's remembered effort when one exists; an explicit level pick is validated and recorded for the resolved route; an explicit provider-default pick clears the route's memory. Memory writes are best-effort like the default-selection save — a read-only settings provider must not make model switching fail. Because the llm runtime now normalizes unsupported efforts to the adapter default rather than rejecting them, a stale remembered level is detected by comparing the restored resolution against the memory and is dropped when normalized away. The composer seat and the /model popup submit plain picks with the route alone (no default-effort prefill, so the memory is not overwritten); effort-pane picks pass `explicitEffort: true`, and a pick the host normalizes to the model's declared default announces through the transient toast (`effort.normalized`).

## Alternatives considered

- **Keep the merged master selector and skip search/recent/collapse.** Rejected: the flat list does not scale past a handful of providers, and the shared helpers and mobile surface already existed — the merge had orphaned them.
- **Client-only in-memory effort memory.** Rejected: a reload would lose every choice; the settings section is the existing durable seam and matches the default selection's deployment-wide scope.
- **Carry the last chosen effort to routes without a memory.** Rejected: effort is a per-model capability and models disagree about levels; applying the last choice across routes would silently select a level the user never chose for that model.

## Consequences

The composer selector scales past one provider again (type to filter, pick from recently used, or collapse providers), and an explicit effort choice now survives model switches and reloads for the exact route it was made on; switching to a route with no memory still presents that model's default. The `session.selectModel` payload gained one optional wire field; existing clients sending the old payload keep the plain-switch semantics. The four previously orphaned locale keys are used again. The per-model memory is deployment-wide (same scope as the default selection); a stale remembered level self-heals on the next plain switch of that route.
