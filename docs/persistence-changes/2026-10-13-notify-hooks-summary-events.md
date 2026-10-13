---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-notify-hooks-summary-events

English | [中文](2026-10-13-notify-hooks-summary-events.zh.md)

## Summary

Adds the log-only session events notify-hooks/summary-request and notify-hooks/summary-result, which record the auxiliary turn-summary model request the dsh-notify-hooks bridge dispatches and the assembled summary it hands to the Stop hook payload.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-notify-hooks-summary-events
baseline: false
changes:
  - root: "event:notify-hooks/summary-request"
    previous: null
    after: "b0254c67f77e25c0ac06565d64f886d7fa87e8cd2d5917a1cf9690a054ef3d33"
    decision: same-version
  - root: "event:notify-hooks/summary-result"
    previous: null
    after: "8b7609e7ca20f5ab56f259f83e2285ee3156f517643d818fd4ea5bc415123c04"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both roots are event-type additions; no existing event payload changes and SESSION_FORMAT_VERSION stays the same. New readers accept older logs unchanged because the records are simply absent and nothing reconstructs session state from them. An older reader refuses a log carrying either unknown event rather than skipping a record it cannot classify, so a deployment must not move backwards while a summarized turn’s session is still in flight. Neither event carries a surfaceOp and neither enters model history: the summary text reaches the model only inside the Stop hook payload the bridge injects.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/hook-protocol: 80 tests passed. The recording command regenerated both catalogs, the machine inventory, and the paired record documents.

<a id="dev-note"></a>
## Dev Note

None.
