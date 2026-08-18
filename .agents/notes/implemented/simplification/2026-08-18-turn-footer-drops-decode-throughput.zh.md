# Agent Note：轮次页脚移除解码吞吐量，StatsLine 保留该指标

Status: implemented

[English](2026-08-18-turn-footer-drops-decode-throughput.md) | 中文

## Problem

轮次速度指标工作把解码吞吐量展示了两次：轮次页脚的 `MessageIconActions` 在用时数字后追加了 `· 34 tok/s`，而 StatsLine 已经从同样的步骤 usage 中渲染了同一吞吐量。页脚这一数字需要把提供方 usage 在轮次的全部步骤间折叠，而页脚的其他数字只是已结算轮次自身的延迟读数。带有专门折叠逻辑的重复数字，是 StatsLine 已经占有的表面积。

## Decision

轮次页脚只显示延迟数字——消息时钟、TTFT 与用时。解码吞吐量只留在 StatsLine。

- `deriveTurnMetrics` 只折叠 TTFT；`tokensPerSecond` 字段离开 `TurnMetrics`、`TurnTailChatData` 与 `MessageIconActions`，`TurnTailNodeView`/`turn-tail.ts` 不再接线该字段。
- 已无引用的 `message.tokensPerSecond` locale key 从两种语言中删除。
- `formatTokensPerSecond` 与 `stats.tokensPerSecond` key 保留，由 StatsLine 消费。

## Alternatives considered

- **保留页脚数字**——拒绝：StatsLine 已经呈现同一吞吐量，而页脚是已结算轮次的摘要；一个数字只应有一个归属。
- **改为从 StatsLine 移走吞吐量**——拒绝：StatsLine 是会话统计的展示面；折叠逻辑消失后，页脚没有对应的每轮解码窗口归属。

## Consequences

轮次页脚不再渲染 tok/s；用户从 StatsLine 读取解码吞吐量。`deriveTurnMetrics` 中的每轮 usage 折叠逻辑已删除，轮次指标不再需要步骤 usage。同一变更中更新了测试（turn-metrics spec 与聊天快照 fixture）；会话日志与线格式无变化。
