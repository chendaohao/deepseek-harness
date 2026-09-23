# Agent Note: Abandoned V3 events drop at the V3-to-V4 edge

Status: implemented

English | [中文](2026-09-23-drop-abandoned-v3-pin-events.zh.md)

## Problem

A stored V3 Session that carries a `session/pin` event cannot be opened. The V3-to-V4 edge refuses every type outside `RELEASED_V3_EVENT_TYPES`, and `session/pin` is absent from that inventory, so the restore fails with `format v3 contains unknown event type "session/pin"`.

[The inventory-growth rule](../bug-fix/2026-09-06-released-format-inventory-event-growth.md) owns this class of failure and prescribes extending the era's inventory. That prescription assumes the type still belongs to the product: it admits a type so the rows a writer emitted stay readable. The pin feature is abandoned, so its rows carry no state a migrated Session needs, and admitting them would preserve data nothing reads.

Two existing extension mechanisms do not reach the case either. An external plugin event survives an equal-version read by carrying `ignorable: true`, but [the historical-refusal decision](../architecture/2026-08-31-alpha-historical-unknown-event-refusal.md) establishes that the marker does not make an event migratable across a format edge. A first-party event migrates only by being named in the edge's inventory, which is the mechanism being declined here.

## Decision

The V3-to-V4 edge owns `DROPPED_V3_EVENT_TYPES`: V3 event types it omits from the V4 artifact instead of carrying. `session/pin` is its only member.

`transformEvent` drops a member directly after the density check. A dropped event consumes no target sequence and emits nothing. The mapping still advances one entry, so the following event's density check holds and no later coordinate moves. The dropped event's own mapping entry is never read, because no event cites a log-only type.

`RELEASED_V3_EVENT_TYPES` is unchanged, so `verify-v3-event-vocabulary` still compares that inventory against its pinned V3 writer exactly.

This supersedes the inventory-growth rule for `session/pin` alone. Every other type that rule covers keeps its treatment, and the v0 inventory retains the `session/pin` disposition it needs to validate a stored v0 payload before the type leaves the log.

## Alternatives considered

**Extend `RELEASED_V3_EVENT_TYPES` with `session/pin`.** The v0-to-v1 work took this route for the same type, and it preserves pin state. It also declares a fork-only type to be part of the released V3 vocabulary, which holds only while the pinned writer is a fork commit that emitted it; the inventory and its verification then depend on which commit is pinned. Rejected because the pin feature is abandoned, so preserving the rows buys nothing that justifies that dependency.

**Mark the stored rows `ignorable: true`.** The marker governs equal-version reads only; a historical edge still refuses an unknown type. Stored rows also carry no marker, so this needs a write-path change and repairs no existing Session.

**Resolve the type from the mounted plugins.** Migration availability would then depend on one deployment's composition and would fail before an absent producer mounts, which [the released-format-migrations decision](../architecture/2026-08-31-released-session-format-migrations.md) rejects.

**Rewrite the stored V3 logs offline.** Stripping the rows means renumbering every following event and remapping every reference that names one. The edge already performs that remapping, so a separate rewrite duplicates it on committed generations, which the [session format version mechanism](../architecture/2026-08-10-session-log-version-mechanism.md) keeps immutable.

**Make `session/pin` an external event.** Dropping the `SessionEventMap` declaration would remove the type from the generated vocabulary, which is the shape this edge already expects. It costs more than the abandonment justifies: `ProjectionDefinition.apply` types its event as `SessionEvent`, a union over declared types only, so a plugin-owned projection cannot name its own type once the declaration is gone. Widening that seam does not work either — an external event's `type: string` overlaps every literal, which breaks discriminant narrowing in every projection implementation. A projection over an external event therefore needs a local widening assertion, and every future one repeats it.

## Consequences

Affected Sessions open, and any later Session carrying `session/pin` migrates the same way.

Pin state is gone for every Session that migrates through this edge, including v0-origin logs: the v0-to-v1 edge still validates the payload, and this edge is where the row leaves the log. A migrated artifact cannot restore that state.

The edge names one type it discards, so `RELEASED_V3_EVENT_TYPES` does not describe everything the edge does with a V3 event. The set is not a general omission mechanism: a second member needs its own justification, and every unlisted unknown type is still refused.

## Testing

- `session-format-v3-to-v4`: a V3 log carrying `session/pin` migrates with the remaining coordinates dense, its neighbours unchanged, and the source rows untouched; a trailing pin row leaves an artifact that reopens.
- `session-format-catalog`: a pin-bearing V3 log drops the rows through the complete chain, and a pin-bearing v0 log reaches V4 with no pin row.
- The catalog spec checks the newest released inventory against `KNOWN_SESSION_EVENT_TYPES` and names its two exemptions: `developer/message`, introduced by the current format, and `session/pin`, the abandoned type this edge drops. Any further addition extends the inventory or joins that list deliberately.
