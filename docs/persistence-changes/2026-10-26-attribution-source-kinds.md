---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-26-attribution-source-kinds

English | [中文](2026-10-26-attribution-source-kinds.zh.md)

## Summary

Integrates qualified attribution source kinds and adds three log-only Crew events for session route selection, single-role route replacement, and role run-budget exhaustion.

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
    previous: "2026-10-27-retry-control-input"
    after: "a58001692fe67a293a3c21e2f7e5bd1bb3d732deb1d9f695b89fcad1834e0691"
    decision: same-version
  - root: "event:crew/route-replaced"
    previous: null
    after: "e30f0e834c0817cbaa588caa8383f33ff81adaac4e569f80ed5f59da2e36b3bc"
    decision: same-version
  - root: "event:crew/routes-selected"
    previous: null
    after: "d3f51c9e496938180094dfb03bde46440c441412d75e07efd6a2338d4f4dcca4"
    decision: same-version
  - root: "event:crew/run-budget-exceeded"
    previous: null
    after: "8239c7b30bbe050798cd0db2886474d3224e8c907ad6b3583a90c68ca66620d5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "75c5d7d73176bdcb70378cee4426b938ab605ae6b28c8318a548407e1f8fc622"
    decision: same-version
  - root: "event:notify-hooks/summary-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "be6f77c280607475a5798dbecf438e4801cb209020e4fed997ab2bec0127fadb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "a8a99e794bd4aa8f66f84c1998799ef38efef00616179254d77d0fdf5b556c9b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "8359f6e0f77fa9790fa08dac2cc717033145283d5a35c448a3dd313a130f8ce2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and the Session writer version does not change. The codegraph-instructions, action-cards, and max-tokens-recovery kinds remain explicitly qualified attribution: unknown kinds and their JSON metadata survive reading without the producer, with no validation, replay, or authority requirement. Historical logs without the Crew events retain their previous route fallback and turn behavior. New readers validate and project the additive Crew event types. Older readers that do not declare these required, non-ignorable events refuse them through the existing unknown-event check before replay, mutation, or recovery; they cannot silently drop a route or budget fact and continue with different behavior.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session/tests/session.spec.ts: 78 tests passed for source validation. pnpm exec vitest run packages/bundle/crew/tests/routes.spec.ts packages/bundle/crew/tests/crew-persona.spec.ts packages/bundle/crew/tests/run-budget.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/client/ui-settings-models/tests/crew-presets-ui.client.spec.tsx: 52 tests passed. pnpm exec vitest run packages/subagent/tool-subagent/tests/worker-route-composition.spec.ts packages/subagent/tool-subagent/tests/worker-route-reselection.spec.ts packages/subagent/tool-subagent/tests/worker-route-settings.spec.ts packages/subagent/tool-subagent/tests/worker-route-guard.spec.ts packages/bundle/crew/tests/formation.spec.ts: 38 tests passed, including durable cold-resume route recovery. pnpm run test:snapshot:record -t crew-session-events, pnpm run test:snapshot:refresh -t crew-session-events, and pnpm run test:snapshot -t crew-session-events passed through the keyless replay path; the Python sdk-crew-events scenario also generated and replayed its expected outputs through the packaged Linux runtime.

<a id="dev-note"></a>
## Dev Note

None.
