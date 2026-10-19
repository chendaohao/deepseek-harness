---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-user-rpc-principal

English | [中文](2026-10-13-user-rpc-principal.zh.md)

## Summary

Adds an optional principal to the user-rpc message source for prompts submitted by a caller other than the owner. Merging this record into the fork re-bases every changed root onto `2026-10-11-branch-line-integration`, so the acknowledged schemas carry both lines' additions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-user-rpc-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-11-branch-line-integration"
    after: "3c400d74bc2264e647b6299406bc133b5059ec8bd1a2d4fa98a07b5fa386598d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-11-branch-line-integration"
    after: "a2d6d74c0fe575889f7164f0b6eca8229758a7963493ba1d53fa1a1792a6f3d0"
    decision: same-version
  - root: "event:notify-hooks/summary-request"
    previous: "2026-10-13-notify-hooks-summary-events"
    after: "e42d3d25a8a6d190daca1569dae70f6c0dbb9f1f5272ef809cc28a4dfaa7a430"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-11-branch-line-integration"
    after: "3b4dc037bcf6c3b69fc3ed8b4c3d4702b79ce1fbe9b67a80e808e661e42430af"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-11-branch-line-integration"
    after: "117216f47c9b4eacdf160ea6365e075a9268cc72be2b689b153406f0eb44b6c2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Owner prompts omit the field, so their sources and every existing Session log are unchanged; an absent principal means the owner. A reader that predates the field ignores it and treats the message as an ordinary user message, because the kind stays 'user'. A current reader of an older log finds no principal and treats every message as the owner's. The field is not part of any model request: provider adapters read only the model-visible message content. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller/tests/remote-access.host.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts: non-owner prompts persist source.principal in agent/inbox/spliced, owner and existing time-zone sources stay byte-identical; all tests passed.

<a id="dev-note"></a>
## Dev Note

None.
