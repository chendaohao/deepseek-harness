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
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "3916aeafff9134c27337057021a31fff4e00e5cc53bf8661c4bf9c9f4e2b428c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a94f17928bcff2689edabfd9c54be62246849b65b1a4d7e9d6ba75777bdc2a03"
    decision: same-version
  - root: "event:notify-hooks/summary-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "b138abc189955de4c965a5a61db127781f66d05be0bb102c8f1530f76b2251ca"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "b0a4b3c1adc79af89f1c9876cbf1733f1def987dfea85a36a55ce6d7134a6a2f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "e1054ff5d45a47a9b57570076effe76c465457ec29a8da27b6b5ba3b49361415"
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
