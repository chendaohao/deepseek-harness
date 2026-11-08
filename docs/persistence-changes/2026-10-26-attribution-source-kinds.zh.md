---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-26-attribution-source-kinds

[English](2026-10-26-attribution-source-kinds.md) | 中文

## 概述

整合限定归因来源种类，并新增三个仅记录日志的 Crew 事件，分别表示会话路由选择、单角色路由替换和角色运行预算耗尽。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效，Session 写入版本不变。codegraph-instructions、action-cards 和 max-tokens-recovery 继续采用显式限定归因：未知种类及其 JSON 元数据在没有生产方时仍能保留读取，且不承担校验、回放或权限要求。不含 Crew 事件的历史日志保持原有路由回退和 turn 行为。新读取方验证并投影这些新增 Crew 事件。未声明这些必需、不可忽略事件的旧读取方，会通过既有未知事件检查在回放、修改或恢复之前拒绝日志，不能静默丢弃路由或预算事实后以不同行为继续。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session/tests/session.spec.ts：78 个来源校验测试通过。pnpm exec vitest run packages/bundle/crew/tests/routes.spec.ts packages/bundle/crew/tests/crew-persona.spec.ts packages/bundle/crew/tests/run-budget.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/client/ui-settings-models/tests/crew-presets-ui.client.spec.tsx：52 个测试通过。pnpm exec vitest run packages/subagent/tool-subagent/tests/worker-route-composition.spec.ts packages/subagent/tool-subagent/tests/worker-route-reselection.spec.ts packages/subagent/tool-subagent/tests/worker-route-settings.spec.ts packages/subagent/tool-subagent/tests/worker-route-guard.spec.ts packages/bundle/crew/tests/formation.spec.ts：38 个测试通过，覆盖持久化后的冷恢复路由保持。pnpm run test:snapshot:record -t crew-session-events、pnpm run test:snapshot:refresh -t crew-session-events 与 pnpm run test:snapshot -t crew-session-events 均通过 keyless replay 路径；Python sdk-crew-events 场景也已通过打包的 Linux runtime 生成并回放预期输出。

<a id="dev-note"></a>
## 开发备注

无。
