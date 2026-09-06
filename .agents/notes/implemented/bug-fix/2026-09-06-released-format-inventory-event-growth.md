# Agent Note: Released format inventories admit every event type the era's writers emit

Status: implemented

English | [中文](2026-09-06-released-format-inventory-event-growth.zh.md)

## Problem

`session/pin` shipped on 2026-08-31 while the released v0 writer was still current, but the v0→v1 edge's frozen `RELEASED_V0_EVENT_DISPOSITIONS` inventory was not extended. The edge's source validation refuses every type outside that inventory — deliberately ignoring both the `ignorable` marker and the installed build's vocabulary — so any stored v0 log carrying a pin event refused restoration on every build, including builds that fully know the type. The refusal surfaced as an unloadable long session in the web client (`format v0 contains unknown historical event type "session/pin" at seq 22278`) the first time a restarted gateway ran ensure-current over the log. `assistant/attempt` marks the era boundary: it was born together with the v2 writer, so its absence from the v0 inventory is correct — only types writable while v0 was current must appear there.

## Decision

The frozen inventory of a released format era is the single registry for the event vocabulary that era's writers can emit, and it grows while the era is current:

1. `'session/pin': disposition(['pinned'])` lands in the v0 inventory. The v1→v2 inventory keeps deriving from it (`...retained`), so one entry admits the type through source validation, v1 target validation, and the v2 target. Payload semantics enforce that `pinned` is a boolean during migration, matching the `dsh-session-pin` invariant.
2. While a released format era is the current writer, every new `SessionEventMap` member extends that era's inventory in the same change. Once the era closes — no writer emits it anymore — its inventory is closed and later types correctly stay out.
3. The executed gate lives in the catalog spec: `KNOWN_SESSION_EVENT_TYPES ⊆ RELEASED_V2_EVENT_TYPES` (the current era). It guards the direction that was unguarded; the v0 spec already asserted the converse (every inventory type is a known type). When a future adjacent edge freezes a new inventory, this assertion retargets to it in the same change.

The refusal policy itself is unchanged: [released format migrations](../architecture/2026-08-31-released-session-format-migrations.md) still refuse unknown historical events even when ignorable, and external plugin events still depend on the `ignorable` marker at restore time.

## Alternatives considered

- **Admit unknown-but-ignorable events in v0 source validation**: rejected. The refusal is deliberate for genuinely external types — migration must not silently carry events no build interprets into a committed generation. The defect was a missing first-party inventory entry, not the refusal policy.
- **Validate the v0 source against the installed `KNOWN_SESSION_EVENT_TYPES`**: blurs the era boundary the edge freezes (a later build with a grown vocabulary would admit types no v0-era writer could emit) and re-couples the frozen edge to the moving current package. Vocabulary admission stays at restore time, per the migration note.
- **Generate the inventories from the event map**: the dispositions carry per-type payload-member semantics (required, optional, opaque) that cannot be derived mechanically; they stay hand-curated under the executed coverage tests.

## Consequences

- Stored pinned v0 sessions migrate: the source generation stays byte- and inode-identical while the v2 successor publishes beside it. Event growth inside a format version no longer bricks migration when the growth lands in the inventory.
- Adding a `SessionEventMap` member without extending the current era's inventory now fails `pnpm test` instead of production loading. The gate moves with the era, so freezing a new edge must retarget it.
- The migration path now enforces the boolean `pinned` payload for historical logs, not only for fresh appends.

## Testing

- `session-format-v0-to-v1`: inventory size pinned at 52, one valid fixture per frozen type, migration of pin-bearing v0 logs preserves the events, and a non-boolean `pinned` refuses.
- `session-format-v1-to-v2`: pin events pass through the stream embedding unchanged.
- `session-format-catalog`: the installed-vocabulary ⊆ newest-inventory invariant, plus a full v0→v2 catalog migration of a pin-bearing log.
- The originally failing session, copied to a temporary root, opens through the JSONL provider, migrates to v2 with the pin event intact, and leaves the v0 bytes untouched.
