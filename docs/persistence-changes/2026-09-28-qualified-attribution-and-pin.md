---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-qualified-attribution-and-pin

English | [中文](2026-09-28-qualified-attribution-and-pin.zh.md)

## Summary

Declares the codegraph checklist message's source kind as a qualified attribution, and acknowledges the fork's session/pin event root.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-qualified-attribution-and-pin
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "ec92be0e17a42a02eedaa745826a5ad3ca3e5dc612ce3f1a8baebbf0b945fb0d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "d9ce2b5a5cf5015008dcd4de4a6097b8b513a4f615e335d825b960d58d3b0153"
    decision: same-version
  - root: "event:session/pin"
    previous: null
    after: "b899dc9ced85ea481542ee210c92b3893f07408e1f7308552e67b448754e8d2f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "b6b2cfd1a51bf17ec5d19b2959b6eab64335c9505148f0955550659cf64b0343"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "394b60fa0bd6fa9c133547281d19dbf50fe24a8c155c9c062b73df52dff71bf5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both additions are backward-compatible. `codegraph-instructions` joins the merge-extensible MessageSourceMap as an explicitly qualified attribution kind: the codegraph plugin reads the kind back only to suppress re-injecting its own checklist into the same session, and imposes no validation, replay, or authority requirement, so a reader without the plugin preserves and derives the recorded message from its stored content. `session/pin` is an ordinary new event type; a reader that does not know it keeps the record and skips the pin projection, whose state the fork has abandoned.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/codegraph: passed. The persistence verifier classifies every change as same-version: attribution-kind-added for the four source slots and root-added for session/pin.

<a id="dev-note"></a>
## Dev Note

None.
