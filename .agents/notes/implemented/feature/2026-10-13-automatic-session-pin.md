# Agent Note: Automatic session pins follow activity and expire after one idle hour

Status: implemented

English | [中文](2026-10-13-automatic-session-pin.zh.md)

## Problem

Manual pins alone could not keep the sessions the user is actively working in at the top: pinning a session before starting work and remembering to unpin it afterwards is exactly the bookkeeping the pinned section exists to eliminate. The requirement: pin a session automatically while it is active, and remove that pin once activity has been over for an hour — without ever letting the automation touch a pin the user placed by hand.

## Decision

The Workspace registry owns automatic pins as a second class of entry in its durable global state. `autoPinnedSessions` records each automatic pin with the ISO instant of the latest observed activity; the existing `pinnedSessionIds` array remains the single display order for manual and automatic pins alike. The field is zod-defaulted, so the domain stays at version 2 and records written before it parse unchanged (the precedent `pinnedSessionIds` set).

The activity signal is pushed, not polled. The Agent registry's `installActivityAutoPin` notes every `agent/status` transition to `noteSessionActivity(sessionId, phase)` with the visible session — a subagent's activity resolves to its nearest non-subagent ancestor, matching the archive-admission model of what keeps a session busy. An `active` note auto-pins an unpinned, unarchived, unsuppressed session; both phases restamp the idle clock.

Expiry is a sweep, not per-session timers. A minute-cadence `sweepAutoPins()` asks the `workspace/session-activity` waterfall for each automatic pin, refreshes the stamp while any provider still reports work (a three-hour turn keeps its pin), and drops the pin once the stamp is one `autoPinIdleTimeout` (one hour by default) old. One sweep at boot retires stale pins a previous run left behind. Both knobs are optional plugin `Config` fields; a failing sweep logs and retries on the next tick.

Manual pins are a hard boundary. An explicit `pinSession` promotes an automatic pin to manual by deleting its entry, so the sweep never manages a pin the user claimed. Manually unpinning an automatic pin records an in-memory suppression, so the feed does not re-add it during the same active episode; the `idle` note lifts it. The suppression is deliberately not durable — a Host restart ends the episode it covers.

## Alternatives considered

**Project active sessions in the client instead of pinning them on the Host.** The pin set would stay purely manual, and every grouping surface would re-derive "active" from its own status snapshot. That puts the rule in every consumer instead of the one registry that owns pin order, and two devices would show different pins.

**Discover active sessions by polling.** Sweeping every known session's activity waterfall on a cadence finds work without a new listener, at one waterfall per session per tick and with no prompt pin when work starts. The push feed pins on the transition itself; the sweep only revalidates the small automatic set.

**Per-session idle timers.** One timer per automatic pin matches the timeout exactly but multiplies handles and needs its own restart durability story; one cadence sweep derives everything from the persisted stamps.

**Durable suppression.** Persisting "the user removed this automatic pin" survives restarts, but it outlives the condition it records: the user objected to re-pinning during one burst of work, not forever. The idle transition is the natural episode boundary, and a restart already ends any live episode.

## Consequences

An automatic pin is indistinguishable from a manual one on the wire and in the client: `pinnedSessionIds` flows through the existing follow feed, so every surface — the sidebar's pinned section above the Workspace groups, the flat list — shows automation-placed pins without a client change.

The turn family is the trigger, but every family refreshes: jobs, subagents, and schedules keep an automatic pin alive through the sweep even when no turn runs, consistent with archive admission. A composition without the Agent registry keeps purely manual pins.

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` (`registry-global automatic session pin`): feed behavior (pin, restamp, idle restart), guards (archived, manual, suppressed), promotion, archive dropping the automatic entry, the sweep (expiry, active refresh, quiet no-write, leftover entries dropped without a waterfall question, boot-failure logging with the write chain intact), and restart durability. `packages/core/agent/tests/auto-pin.spec.ts` covers the feed: plain and ancestor-resolved transitions, broken lineage, absent registry, and contained noting failures.
