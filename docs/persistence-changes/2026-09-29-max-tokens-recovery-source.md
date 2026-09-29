---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-max-tokens-recovery-source

English | [中文](2026-09-29-max-tokens-recovery-source.zh.md)

## Summary

Adds the `max-tokens-recovery` user-message source kind that the bounded ceiling recovery stamps on the prompt it queues.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-max-tokens-recovery-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "71dd8a84c5d87d296b428a884d29763c6076fae6a3ff4bbcbc8682835c3c6dab"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "ce22c6b205e86a192e065bf994aec4f86c512b79d8cf457718850dd23664a780"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "6a913d703e889efde3e4245cc0ab5629485ebb5a8d8fbd7bb3470466f7840f3e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "54a186bfd07865c27f0942c6c978cf64e6885c9e78fb033b16ead14d2521494e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The kind is an explicitly qualified attribution: a reader that does not know it preserves the recorded message content and form instead of refusing the log, and the producer owns no validation, replay, or authority requirement beyond reading the kind back. The four affected roots only gain one source alternative.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/max-tokens-recovery/tests/max-tokens-recovery.spec.ts: 6 tests passed. The persistence verifier classifies all four source slots as attribution-kind-added at the same format version.

<a id="dev-note"></a>
## Dev Note

None.
