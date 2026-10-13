---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-13-notify-hooks-summary-events

[English](2026-10-13-notify-hooks-summary-events.md) | 中文

## 概述

新增仅记录的会话事件 notify-hooks/summary-request 与 notify-hooks/summary-result，分别记录 dsh-notify-hooks 桥接派发的回合总结辅助模型请求，以及交付给 Stop 钩子载荷的汇总文本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两个根都是事件类型新增；既有事件载荷不变，SESSION_FORMAT_VERSION 保持不变。新读取器原样接受旧日志：这些记录只是缺失，没有任何会话状态依赖它们重建。旧读取器遇到携带任一未知事件的日志会拒绝读取，而不是跳过无法分类的记录，因此当含已总结回合的会话仍在进行时，部署不得回退。两个事件都不带 surfaceOp，也不进入模型历史：汇总文本只通过桥接注入的 Stop 钩子载荷抵达模型。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/hook-protocol：80 个测试通过。记录命令已重新生成两份目录、机器清单与配对记录文档。

<a id="dev-note"></a>
## 开发备注

无。
