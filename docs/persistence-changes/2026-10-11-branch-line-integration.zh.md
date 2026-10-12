---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-branch-line-integration

[English](2026-10-11-branch-line-integration.md) | 中文

## 概述

两条分支线曾独立推进四个消息来源 root，本记录确认其合并后的状态——max-tokens-recovery 与 codegraph-instructions 两个限定归因 kind 落在上游线之上——并新增仅入日志的事件 subagent/worker-route，记录委派子会话的 LLM 路由跟随指定的 Host 设置命名空间。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

每个新增来源 kind 都是槽位中显式限定的归因，变迁前后策略一致：生产方读取自己的 kind 仅用于抑制重复注入，缺少生产方的读取方保留所记录的消息并从存储内容推导，即 2026-09-21 与 2026-09-28 两条记录为这些槽位确立的契约。subagent/worker-route 是普通事件类型新增：新读取方读取旧日志不受影响，因为没有该标记即保持创建时固定的路由；旧读取方遇到携带该未知事件的日志会拒绝读取，而不会重建一个无法正确路由的子会话，因此带标记工人会话在途期间部署不可回退。该事件不携带 surfaceOp，从不进入模型历史。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/codegraph packages/guard/max-tokens-recovery packages/subagent/tool-subagent：通过，包括 worker-route-state.spec.ts 的标记覆盖与 worker-route-reselection.spec.ts 基于共享存储的冷恢复。线性化后的历史通过 validatePersistenceHistory；2026-09-21 与 2026-09-28 之间的分叉通过将本地线排在上游线之后解决。

<a id="dev-note"></a>
## 开发备注

无。
