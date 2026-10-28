---
kind: upgrade-guide
description: "Session follow 会发出 assistant-stream-batch 帧；旧 Client 必须展开它们，或改用单帧合批配置。"
---
# Session follow 新增 assistant-stream-batch

[English](guide.md) | 中文

## 变更

`session/follow` 现在可以在 attempt 首个 chunk 之后发出 `{ type: 'assistant-stream-batch', frames: [...] }`。每个嵌套帧保留原有 revision 和 index。仅处理 `assistant-stream` 的 Client 可能拒绝或跳过这些批次；更新后的 Client 会自动展开。`assistantStreamBatchSize` 默认为 64。

## 迁移

1. 更新 Client 的 `SessionFollowFrame` 处理，按顺序遍历 `frames`，并对每个嵌套帧执行原有 revision 连续性校验。不要把整个批次当成一个 revision，也不要丢弃帧级 index。
2. 如果暂时无法更新 Client，请在 `cordis.yml` 的 `SessionController` 行设置 `assistantStreamBatchSize: 1`，让所有 Assistant 帧保持原有单帧形式。
3. 用多个 chunk 验证：attempt start 和首个 chunk 以 `assistant-stream` 到达，后续 chunk 按原顺序到达，attempt 结束时 revision 连续且 durable event seq 不变。
