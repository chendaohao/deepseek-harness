---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-user-rpc-principal

[English](2026-10-13-user-rpc-principal.md) | 中文

## 概述

为 owner 以外的调用方提交的 prompt，在 user-rpc 消息来源上增加可选的 principal。合入 fork 后，本记录改接在 `2026-10-11-branch-line-integration` 之后，因此确认的 schema 同时包含两条线的增补。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

owner 的 prompt 不写该字段，因此其来源与所有既有 Session 日志都不变；缺少 principal 即为 owner。早于该字段的读取方会忽略它，并因 kind 仍为 'user' 而把消息当作普通用户消息。当前读取方读取旧日志时找不到 principal，把每条消息都视为 owner 的消息。该字段不进入任何模型请求：provider 适配器只读取模型可见的消息内容。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/session-controller/tests/remote-access.host.spec.ts packages/subagent/subagent/tests/control.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts：非 owner 的 prompt 在 agent/inbox/spliced 中持久化 source.principal，owner 与既有时区来源保持逐字节不变；全部测试通过。

<a id="dev-note"></a>
## 开发备注

无。
