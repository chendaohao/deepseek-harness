---
kind: upgrade-guide
description: "续接调用方窗口的 session/follow opening 不再携带活跃 attempt 的紧凑 Assistant stream。"
---
# Session follow 新增 assistant-stream-batch

[English](guide.md) | 中文

## 变更

attempt 首个 chunk 之后，`session/follow` 可以发出 `{ type: 'assistant-stream-batch', frames: [...] }`。每个嵌套帧保留原有 revision 与 index。仅处理 `assistant-stream` 的 Client 可能拒绝或跳过这些批次。`assistantStreamBatchSize` 默认为 64。

回应调用方 `afterSeq` 的 opening（`continued: true`）不再携带 `assistantStream.activeAttempt.stream`，只带 attempt 的 `attemptId`、`startedAfterSeq`、`turn`、`step` 与 `nextIndex`。这类调用方已持有该前缀描述的全部持久事件，因此 Host 只发送接受后续帧所需的游标元数据。普通 opening 仍然发送完整紧凑前缀。无条件展开 `stream` 的 Client 会重建出零条瞬态行，随后照常接受后续帧，因此无需改动也能继续工作。

## 迁移

1. 更新 Client 的 `SessionFollowFrame` 处理，按顺序遍历 `frames`，并对每个嵌套帧执行原有 revision 连续性校验。不要把整个批次当成一个 revision，也不要丢弃帧级 index。
2. 不要再依赖 `continued` opening 上的 `assistantStream.activeAttempt.stream`。用元数据重新播种 attempt 的游标状态，让持久 settlement 承载正文；展开空 `stream` 本来就是正确行为，只有假设前缀非空的代码需要修改。
3. 如果暂时无法更新 Client，请在 `cordis.yml` 的 `SessionController` 行设置 `assistantStreamBatchSize: 1`，让所有 Assistant 帧保持原有单帧形式。
4. 在 attempt 进行中重连验证：重连后的第一帧按自己的 index 被接受，持久 settlement 仍能重建完整消息。
