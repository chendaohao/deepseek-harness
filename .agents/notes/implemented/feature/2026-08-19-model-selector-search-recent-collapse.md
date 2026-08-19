# Agent Note: Model selector search, recently-used, and collapsible providers

Status: implemented

English | [中文](2026-08-19-model-selector-search-recent-collapse.zh.md)

## Problem

The composer model seat and the mobile remote sheet both render the provider-grouped model catalog as one flat vertical list. With many configured providers and models, picking a specific model means scrolling through every provider; the selector did not scale past a handful of options.

## Decision

Both surfaces gain the same three affordances over the shared `session.models` directory. A search box filters the catalog flat by model id, model name, or provider name (case-insensitive substring); a pinned recently-used section re-offers the last picks the current catalog still advertises; each provider collapses under its own header with a model-count badge. The `/model` command popup and the effort pane/section are unchanged.

Search, recent, and collapse state is per-open and per-surface. Recently-used routes persist per device in `localStorage` (key `dsh:recent-models`, capped at 6, deduplicated most-recent-first) through a shared helper in `@deepseek-ai/dsh-client-ui-primitives` — `readRecentModels` / `writeRecentModel` / `useRecentModels` — plus `modelMatchesQuery`, the single filter implementation both surfaces call so their search behavior cannot drift. Stale routes drop from the display by intersecting with the catalog; storage stays bounded by the cap and never feeds a model request, so it stays off the session log.

## Alternatives considered

- **Provider-first two-level drill (pick provider, then model).** Rejected: an extra tap on every pick, and search still needs a flat results view.
- **User-configured favorites/pinning.** Rejected: adds a settings surface; recency already covers the switch-between-a-few-models case with no configuration.
- **Collapsible providers alone, no search or recency.** Rejected: collapse shortens the scroll but still requires opening each provider to find a model.

## Consequences

Both the web dropdown (`ModelSelect`) and the mobile sheet (`ModelSheet`) stay usable with many providers: type to filter, pick from recently-used at the top, or collapse providers you are not using. Web keyboard behavior extends to the search field (ArrowDown enters the list, Escape clears the query before backing out of the pane). The ARIA menu structure keeps the search input out of `role="menu"` so it is not an invalid menuitem. Search and collapse state resets on each open; recent state persists per device and is deliberately not shared across origins (the web host and the phone's `/m` page keep their own lists).
