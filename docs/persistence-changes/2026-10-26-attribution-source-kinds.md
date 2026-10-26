---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-26-attribution-source-kinds

English | [中文](2026-10-26-attribution-source-kinds.zh.md)

## Summary

Records the `codegraph-instructions`, `action-cards`, and `max-tokens-recovery` source kinds as qualified attribution alternatives on the user, developer, inbox-splice, and title-request roots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-attribution-source-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "e6a92c7626f9f41c08707a883f4140c146e5626790104fbfda6d39e9a1c11e88"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "6f493de1eddb72660318a1e2205dba14ab907f520618f9f22be075b099f29f48"
    decision: same-version
  - root: "event:notify-hooks/summary-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "f85458249354d5999fa2bb9956142542cf11ce8a645593d8f3205f6609853753"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "eb135c3f7f9177197a30e11e34b19bc78da9196a6fa6d2757d2b28c41b9e2701"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "67596f5ede354ec7b533fdef4c11e43ab5dfece88bcce30ddea98b8556594e60"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and no writer version changes. All three kinds are explicitly qualified attribution (`@persistenceAttribution`): each declares one literal discriminator, and `MessageSourceMap` producers promise that an unknown kind and its JSON metadata survive reading without the producer, imposing no validation, replay, or authority requirement. A reader that does not know a kind preserves the recorded message content and form instead of refusing the log; the producer alone reads its own kind back, for duplicate-suppression projection. `assertMessageEventShape` therefore accepts any non-empty string `kind` on user and developer messages and keeps the source record intact. Absence of any of these kinds retains the previous behavior, so a log without them replays exactly as before. The five affected roots only gain source alternatives; their other structure and every digest-bearing declaration are otherwise unchanged.

<a id="verification"></a>
## Verification

pnpm run verify-persistence-changes --json classifies all nine slots as attribution-kind-added with requiresCompatibilityReview false, and the declarative check passes with 69 roots across 22 records. pnpm exec vitest run packages/core/session/tests/session.spec.ts: 78 tests passed, covering the source validation this record relies on.

<a id="dev-note"></a>
## Dev Note

None.
