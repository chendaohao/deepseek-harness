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
## 兼容性

已有记录仍然有效，写入版本不变。三种 kind 都是显式限定的归属（`@persistenceAttribution`）：每种只声明一个字面量判别值，`MessageSourceMap` 的生产方承诺未知 kind 及其 JSON 元数据在不加载该生产方的情况下仍可读取并保留，不构成任何校验、回放或权限要求。不认识某个 kind 的读者保留记录的消息内容与形态，而不是拒收日志；只有生产方自己会回读该 kind，用于去重投影。因此 `assertMessageEventShape` 接受 user 与 developer 消息上任意非空字符串 `kind`，并原样保留 source 记录。这些 kind 缺失时保持原有行为，没有它们的日志回放与过去完全一致。受影响的五个根只新增来源备选，其余结构与所有参与摘要的声明均未改变。

<a id="verification"></a>
## 验证

pnpm run verify-persistence-changes --json 将九个位置全部归类为 attribution-kind-added 且 requiresCompatibilityReview 为 false，声明式检查以 22 条记录覆盖 69 个根通过。pnpm exec vitest run packages/core/session/tests/session.spec.ts：78 个测试通过，覆盖本记录依赖的来源校验。

<a id="dev-note"></a>
## 开发备注

无。
