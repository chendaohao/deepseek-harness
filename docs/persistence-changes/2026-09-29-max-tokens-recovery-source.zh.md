---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-max-tokens-recovery-source

[English](2026-09-29-max-tokens-recovery-source.md) | 中文

## 概述

新增 `max-tokens-recovery` 用户消息来源 kind，供有界触顶恢复为其排入的提示打标。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-max-tokens-recovery-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "71dd8a84c5d87d296b428a884d29763c6076fae6a3ff4bbcbc8682835c3c6dab"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "ce22c6b205e86a192e065bf994aec4f86c512b79d8cf457718850dd23664a780"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "6a913d703e889efde3e4245cc0ab5629485ebb5a8d8fbd7bb3470466f7840f3e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-28-qualified-attribution-and-pin"
    after: "54a186bfd07865c27f0942c6c978cf64e6885c9e78fb033b16ead14d2521494e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。该 kind 是显式限定的归属标注：不认识它的读取方会保留记录中的消息内容与 form，而不是拒绝该日志；写入方除读回该 kind 外不主张任何校验、重放或权威要求。四个受影响的根各自只新增一个 source 备选。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/max-tokens-recovery/tests/max-tokens-recovery.spec.ts：6 个测试通过。持久化校验器把四个 source 槽位全部判为同版本的 attribution-kind-added。

<a id="dev-note"></a>
## 开发备注

无。
