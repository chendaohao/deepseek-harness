# Agent Note: A released edge admits its era's payload versions, and one refused log keeps search alive

Status: implemented

English | [中文](2026-09-17-released-descriptor-version-window.zh.md)

## Problem

The v0→v1 edge refused descriptor version 2 outright, and that refusal took full-text search down with it. A `subagent/descriptor` event carrying `version: 2` threw `subagent/descriptor 0 uses unsupported descriptor version 2`, the session-search indexer treats any unreadable cold log as a failed observation, and one such log therefore failed *every* search — not only searches that would have matched it. The user-visible symptom was a sidebar search that returned an error for every query.

Two independent defects produced that outage, and each is fixed on its own terms: the inventory refused a version the era's writers did emit, and the indexer let one unreadable source deny every other Session to the query. Fixing only the first left the second reachable through four unrelated logs.

The check assumed v0-era writers only ever emitted descriptor version 3. The record contradicts that. `SUBAGENT_DESCRIPTOR_VERSION` moved 1 → 2 → 3 on 2026-07-23, 07-27, and 08-24, while `SESSION_FORMAT_VERSION` stayed at 0 until 2026-08-31 — so the v0 era spans all three descriptor versions. The earliest product tag, `dsh-v0.1.0-rc.7`, already shipped format v0 with descriptor version 2, and all 17 release tags carry 2 or 3. Version 1 predates the first tag and never shipped.

The gap was narrow: descriptor version 2 differs from 3 by one optional member, `agentReasoningEffort`, which version 3 added. Every other member is shared, so a version-2 payload is fully interpretable by the version-3 reader. `foldSubagentDescriptor` already returned `undefined` — not an error — for a version it does not recognize, so downstream consumers were built to tolerate an unreadable descriptor.

## Decision

The v0 inventory admits the descriptor versions a released writer could have emitted, and names them where the rest of that era's vocabulary lives:

1. `RELEASED_SUBAGENT_DESCRIPTOR_VERSIONS = [2, 3]` joins `dispositions.ts`. Both validation sites — the source-level guard in `validation.ts` and the payload-level `literalValue` in `payload-validation.ts` — read that one constant, so the two cannot drift.
2. The list is hardcoded rather than read from `SUBAGENT_DESCRIPTOR_VERSION`. A released edge freezes the vocabulary its own era's writers emitted; deriving it from the installed package would let a later build admit a version no v0 writer could produce.
3. Version 1 stays refused. It never shipped, and it lacks the `mode` member this inventory requires, so admitting it would mean guessing a lifecycle mode the bytes do not carry.

This is the same defect class and the same remedy as [the inventory-growth rule](2026-09-06-released-format-inventory-event-growth.md): the refusal policy is correct, and the inventory was incomplete. That note grew the v0 inventory by an event *type*; this one grows a nested payload's admitted *versions*. The `version` member of `subagent/descriptor` is era-frozen vocabulary exactly as an event type is.

### One refused log must not deny every other Session

Widening the inventory fixed 11 logs but not the outage, because the indexer's failure was never specific to the descriptor version. Four logs stay permanently refused by deliberate policy: three carry a `vision/observed` event from a plugin that existed only on a development branch, and one is a Claude import the v2→v3 chronology rule refuses. Any one of them failed every search on its own.

The session-search observer now leaves out a stored log whose format edge permanently refuses it, and warns once per Session with its id. `SessionFormatUnsupportedError` is the only skipped class. It marks a settled property of one source — no retry can index it, and no other Session depends on it — so the choice is between one unsearchable log and a wholly broken search, not between succeeding and failing. A backend failure or a corruption still fails the observation, because those can clear on retry or describe the store rather than a single source.

The skipped Session's content stays unsearchable until a build that can read it indexes it. That is the honest limit of the exclusion: it trades an unanswerable query into a missing result rather than an error, and the warning names which Session is missing so the gap is discoverable.

## Consequences

- Released v0 logs carrying descriptor version 2 restore again. On the machine that reported this, 11 stored sessions became readable.
- The v1→v2 and v2→v3 edges call the same `assertReleasedPayloadSemantics`, so they inherit the widened window. That is correct rather than incidental: those edges validate the same historical payloads on their way to the current generation, and a version-2 descriptor is no less interpretable one edge later. Native V3 validation is unaffected — `assertV3Event` checks envelopes only and does not call the payload validator.
- Version 3 remains the only version the *current* writer emits. Admitting version 2 in a frozen edge does not relax what a fresh append may carry; `SUBAGENT_DESCRIPTOR_VERSION` still governs that.
- Full-text search works again on that machine: 215 of 252 stored logs are indexed, and the four refused ones are excluded with a warning rather than failing every query.
- A deployment that cannot read one stored log now gets partial search instead of none. That is the intended trade: the alternative silently converted one Session's unreadability into a total feature outage, which is what made this incident hard to diagnose — the error named a descriptor version while the symptom was an empty sidebar.

## Alternatives considered

- **Make the indexer skip unreadable logs, as the only fix**: rejected. On its own it hides the inventory gap: 11 logs were valid released history that a correct build must read, and skipping them would have silently dropped their content forever. The skip is right only for refusals that are deliberate and permanent, which is why it recognizes one error class rather than any read failure.
- **Reject the whole observation when any source is refused**: the shipped behavior before this note, and rejected. It makes one unreadable log deny every other Session to the query, so the blast radius of a single unreadable file is the entire feature.
- **Admit descriptor version 1 as well**: rejected. No release tag ever carried it, and its payload lacks the `mode` member the inventory requires, so there is no defensible way to classify a child as one-shot or continuable from those bytes.
- **Read the version window from `SUBAGENT_DESCRIPTOR_VERSION`**: rejected for the reason in the Decision: it couples a frozen edge to a moving package and would admit future versions no v0 writer could emit.
- **Special-case the check to accept anything below the current version**: rejected. The window is a recorded fact about released writers, not a "newer is better" heuristic; version 1 must still refuse.
- **Add `vision/observed` to the v0 inventory**: rejected. The event is not first-party in this checkout — no build here interprets it — so admitting it would carry an uninterpretable event into a committed generation, which is exactly what the closed-inventory rule refuses. (On the development branch that did define it, that inventory entry is a separate, still-open gap.)

## Testing

- `session-format-v0-to-v1/tests/validation.spec.ts` restores real v0 rows carrying descriptor versions 2 and 3, and asserts versions 1 and 4 still raise `SessionFormatUnsupportedMigrationError` naming the offending version. Reverting the constant to `[3]` fails that test with the exact production error.
- The valid-fixture inventory gains version-2 descriptor payloads in both lifecycle modes, including one with the optional members version 3 later added.
- `session-query-sqlite/tests/sqlite.spec.ts` stores one readable Session beside one released-v0 log whose event the frozen inventory refuses, and asserts the readable Session stays searchable, the refused Session contributes no index row, and exactly one warning names it. Removing the skip fails that test with the production `persistence observation failed` error.
- Restoring the originally failing stored log through the real format catalog and adjacent chain yields a v3 artifact with the version-2 descriptor preserved verbatim.
