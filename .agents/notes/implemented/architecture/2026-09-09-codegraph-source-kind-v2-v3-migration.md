# Agent Note: Admitting the fork codegraph source kind through the V2→V3 migration

Status: implemented

English | [中文](2026-09-09-codegraph-source-kind-v2-v3-migration.zh.md)

## Problem

After the 0.1.5-alpha.1 merge, opening any session whose V2 log contains a codegraph-injected checklist message failed with `failed to observe session ...: cannot safely transform unclassified message source (gateway/internal)` — the whole workspace's history became unopenable on every client.

The upstream `session-format-v2-to-v3` migrationer validates every migrated message source against a closed vocabulary (`SOURCE_KINDS` in `payload.ts`). The fork's codegraph plugin (`packages/codegraph`) writes its own merge-extensible `MessageSourceMap` kind — `codegraph-instructions` — into `user/message` sources, and the V2→V3 migration asserts sources on `user/message`, `assistant/message`, `tool/result`, inbox splices, and title LLM requests. A fork V2 log therefore carried a kind upstream has never seen, and the merge reconciliation missed the extension: sources pass through migration unchanged, but the admission check refused them before the pass-through.

Reproduction: the real session's V2 log fed through `assertEvent(…, 2)` rejected exactly one event (`user/message` seq 332, `codegraph-instructions`); after the fix the full artifact migrates v2→v3 (659 events in, 663 out, system-head promotion included).

## Decision

**Teach the migration admission the fork's kind — with a shape check, not blind acceptance.** `payload.ts` adds `codegraph-instructions` to `SOURCE_KINDS`, and `assertSource` gains a branch mirroring the existing `agent-message` precedent: `keys(source, ['kind', 'form'])` with `form` required to be `'instructions'`, matching the `CodegraphInstructionSource` contract in `packages/codegraph`.

The V3 side needed nothing: the codec's `MessageSourceMap` is merge-extensible and the Trajectory projection renders unknown kinds by their durable kind string (`trajectory-event-projection.ts` default branch).

## Alternatives considered

- **Strip or rewrite the source during migration** — rejected: released-format migrations never move, overwrite, or reinterpret committed history; the kind is durable identity for the checklist message.
- **Leave old V2 sessions unmigrated and only let new sessions through** — rejected: the adjacent-migration policy requires every old log to reach V3; refusing one fork-written message kind locks the whole session out.

## Consequences

- Every fork V2 session with codegraph-injected messages migrates cleanly; sessions without them are unaffected.
- The kind list stays closed: a future fork plugin that adds a `MessageSourceMap` kind must extend this admission list in the same change (the type-level `MessageSourceMap` merge does not reach this JSON-level check).
- `session/title` events carrying `source: { kind: 'fallback' }` are untouched: `assertSource` does not run for `session/title` (it audits Harness messages, not the title's own source field).

## Verification

`tests/admission.spec.ts` gains the positive path (V2 `codegraph-instructions` migrates, source passes through verbatim into the V3 artifact) and malformed-shape rejections (wrong `form`, extra field → `codegraph-instructions source` errors). Full session-domain suite (1613 tests) and the keyless recorded-session snapshot replay (127 tests) pass; the real previously-failing session completes end-to-end migration through the released `sessionFormatV2ToV3` stage.
