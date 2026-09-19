# Agent Note: One per-device provider order for the Models page and the model selector

Status: implemented

English | [中文](2026-09-11-shared-provider-order-across-model-surfaces.zh.md)

This gives the model selector the provider order the [Models settings page](../../../../packages/client/ui-settings-models/README.md) already persists, and moves that store into the package both surfaces may import.

## Problem

The Models settings page lets a user drag provider rows into a per-device order stored in `localStorage` under `dsh:provider-order`. The model selector — the composer seat and the `/model` popup — listed providers in the Host catalog's registration order instead, so two surfaces on one device disagreed about which provider came first.

The order's home was also wrong. `provider-order.ts` lived in `ui-settings-models`, and a feature plugin must not runtime-import another feature plugin's values, so the selector could not read it. `@deepseek-ai/dsh-client-ui-primitives` already owns the shared `recent-models` store for exactly this reason.

## Decision

Move the provider-order store — `PROVIDER_ORDER_KEY`, `readProviderOrder`, `writeProviderOrder`, and `applyProviderOrder` — into `@deepseek-ai/dsh-client-ui-primitives`, the narrow static owner both features may import. `ui-settings-models` reads and writes it through that export and keeps only its drag-geometry helper (`reorderedProviderIds`).

Both selector entries apply `applyProviderOrder` over the loaded catalog groups. The composer seat holds the order in per-open state, re-reading it when the menu opens, so a drag on the settings page reaches the selector's next open; the `/model` popup reads the order when it builds its options. Provider ids absent from the stored order keep their catalog order and follow the positioned ones. The recently-used section is capped at five by `RECENT_LIMIT` in the same package, restoring the cap the [model selector search, recently-used, and collapsible providers](../../implemented/feature/2026-08-31-model-selector-search-recent-effort-memory.md) note records; the three this note originally set was reverted later. The subagent model-allowlist card groups its candidates by provider in the same order, so one drag reaches every surface that lists providers.

## Alternatives considered

- **Keep the order in `ui-settings-models` and import it from the selector.** Rejected: a feature plugin importing another feature plugin's runtime values is what the client layering forbids; shared runtime code belongs in `ui-primitives`.
- **Order providers on the Host so every client agrees.** Rejected when the drag shipped, and unchanged here: the order spans two settings namespaces with no shared document home, and a paired (forwarded) client is read-only against settings, so a Host copy would be unwritable from the phone. The order is a display preference, not a model fact, so it also stays off the session log.
- **Store one order shared by the phone and the host.** Rejected: they are separate browsers with separate `localStorage`, so a shared copy would need a new writable Host preference API and would let a reorder on one screen rearrange the other. The one copy that matters is per device, shared by every surface on it — which this change makes true.
- **Cap the recently-used list where it is displayed instead of where it is stored.** Rejected: storage would keep growing and every reader would repeat the cap.

## Consequences

The Models page and both selector entries agree on provider order within a device, and a provider added later still appends after the ordered ones. `RECENT_LIMIT` is five, and a stored list longer than that is trimmed on the next read. The store is a public export of `ui-primitives`; the settings package no longer carries it.
