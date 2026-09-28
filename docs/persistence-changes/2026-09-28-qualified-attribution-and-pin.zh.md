---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-28-qualified-attribution-and-pin

[English](2026-09-28-qualified-attribution-and-pin.md) | 中文

## 概述

把 codegraph 清单消息的 source kind 声明为已限定归属，并确认 fork 自有 session/pin 事件根。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两处新增均向后兼容。`codegraph-instructions` 作为显式限定的归属 kind 加入可扩展的 MessageSourceMap：codegraph 插件只读回该 kind 以抑制对同一会话重复注入清单，不做校验、重放或权威判定，因此没有该插件的读者也能从存储内容中保留并派生出这条消息。`session/pin` 是普通新增事件类型；不认识它的读者会保留记录并跳过 pin 投影，该状态已被 fork 放弃。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/codegraph：通过。持久化校验器把全部变更判为同版本：四个 source 槽位为 attribution-kind-added，session/pin 为 root-added。

<a id="dev-note"></a>
## 开发备注

无。
