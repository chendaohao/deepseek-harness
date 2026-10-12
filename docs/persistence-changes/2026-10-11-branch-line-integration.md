---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-branch-line-integration

English | [中文](2026-10-11-branch-line-integration.zh.md)

## Summary

Acknowledges the integrated state of the four message-source roots after two branch lines advanced them independently — the max-tokens-recovery and codegraph-instructions qualified attribution kinds land on the upstream line — and adds the log-only event subagent/worker-route, recording that a delegation child's LLM route follows the named Host settings namespace.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-branch-line-integration
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-05-working-directory-attribution"
    after: "bc134cfc11581848c009b4649470a46a1d89c8c666d161d6c557e1fcf8930542"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "24864837b1452b06e6194071d2a1affec9c8bcd4346369ecf77fa1efebc106cc"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "97c1b904ed18a80adba9cb64090bc72180e0636bd0530265f81b540ab9b66de3"
    decision: same-version
  - root: "event:subagent/worker-route"
    previous: null
    after: "0b0ad6085ff8eefd380b579be5331360bb8d2f10c83b7d0a08897998177bc9e8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "a7caf5865d2ebdcb4ce7d2239881763db1fc34cbd234be28f3bab0bd066c3a05"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Every added source kind is an explicitly qualified attribution in a slot whose before and after carry the same supported policy: the producer reads its own kind only to suppress duplicate injection, and a reader without the producer preserves the recorded message and derives it from stored content, the contract the 2026-09-21 and 2026-09-28 records established for these slots. subagent/worker-route is an ordinary event-type addition: new readers accept older logs unchanged since absence of the marker means the creation-fixed route, and older readers refuse a log carrying the unknown event rather than reconstructing a child they cannot route, so a deployment must not move backwards while a marked worker's session is in flight. The event carries no surfaceOp and never enters model history.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/codegraph packages/guard/max-tokens-recovery packages/subagent/tool-subagent: passed, including worker-route-state.spec.ts marker coverage and worker-route-reselection.spec.ts cold-resume over a shared store. The linearized history passes validatePersistenceHistory; the fork between 2026-09-21 and 2026-09-28 is resolved by ordering the local line after the upstream line.

<a id="dev-note"></a>
## Dev Note

None.
