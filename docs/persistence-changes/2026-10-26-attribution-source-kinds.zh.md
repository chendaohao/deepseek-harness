---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-26-attribution-source-kinds

[English](2026-10-26-attribution-source-kinds.md) | 中文

## 概述

登记 `codegraph-instructions`、`action-cards` 与 `max-tokens-recovery` 三个来源类型，作为 user、developer、inbox-splice 与标题请求各根上的合格归属备选。

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
## 兼容性

已有记录仍然有效，写入版本不变。三种 kind 都是显式限定的归属（`@persistenceAttribution`）：每种只声明一个字面量判别值，`MessageSourceMap` 的生产方承诺未知 kind 及其 JSON 元数据在不加载该生产方的情况下仍可读取并保留，不构成任何校验、回放或权限要求。不认识某个 kind 的读者保留记录的消息内容与形态，而不是拒收日志；只有生产方自己会回读该 kind，用于去重投影。因此 `assertMessageEventShape` 接受 user 与 developer 消息上任意非空字符串 `kind`，并原样保留 source 记录。这些 kind 缺失时保持原有行为，没有它们的日志回放与过去完全一致。受影响的五个根只新增来源备选，其余结构与所有参与摘要的声明均未改变。

<a id="verification"></a>
## 验证

pnpm run verify-persistence-changes --json 将九个位置全部归类为 attribution-kind-added 且 requiresCompatibilityReview 为 false，声明式检查以 22 条记录覆盖 69 个根通过。pnpm exec vitest run packages/core/session/tests/session.spec.ts：78 个测试通过，覆盖本记录依赖的来源校验。

<a id="dev-note"></a>
## 开发备注

无。
