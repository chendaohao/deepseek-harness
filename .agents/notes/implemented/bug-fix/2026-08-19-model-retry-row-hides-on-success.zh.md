# Agent Note: model-retry 提示在重试成功后自动消失

Status: implemented

[English](2026-08-19-model-retry-row-hides-on-success.md) | 中文

## 问题

模型请求失败、`dsh-llm-retry` 调度重试时，对话流里会出现一条短暂的"正在重试模型请求（1/2）…"行（`model-retry` 节点，由 `ModelRetryItem` 渲染）。该节点的 Definition 只匹配 `llm/retry` 与 `llm/retry-started`，没有任何"重试已成功"的收敛逻辑，因此一旦物化就永远留在对话流里——即使被重试的尝试已经产出了最终答案。

## 决定

`model-retry` 是短暂提示，不是持久记录。在 `retry.ts` 的 `buildViewNode` 中，当所在 step 已发布的 `assistant-step` 数据为 `status === 'settled'`（完成态最终 `assistant/message`；`resetForRetry` 保证其只能来自被重试的那次尝试）时，返回 `visibility: 'hidden'` 节点——若该窗口内链从未物化则返回 `null`。这与 `turn-error` 节点的抑制模式一致（[节点装配](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)）。无需新的唤醒机制：`step/end` 位置边界本来就会重放重试 context，隐藏节点从对话流 `order` 中消失，但仍保持物化以维持时间线/分支稳定。

判定用 `status === 'settled'` 而非 `finalNode !== undefined`：assistant Definition 会为被中止或出错的中断流合成 `interrupted` 的 final node——那种情况下重试并未干净成功，行应保留作为中断回合记录的一部分。

## 备选方案

- **按 `finalNode !== undefined` 隐藏** —— 否决：被中断的流也会合成 final node，会把未干净成功的重试也一并隐藏。
- **把重试节点以 (turn, step) 为 key 并匹配 `step/end` / `assistant/message` 来唤醒** —— 否决：`match` 是无状态的，会对每个 step 产生僵尸 context。
- **在 `start` 里加 `reader.previous('assistant-step')` 依赖以提前一个事件隐藏** —— 否决：assistant context 每个 chunk 都会 revision，重试 context 会按 token 重放，只为感知上可忽略的提前量。

## 后果

- 重试成功后的"正在重试…"行在 `step/end` 自动消失，历史重载后也不再出现；重试耗尽或被中断时仍保留可见行。
- 新增三条节点装配测试覆盖 live 隐藏、历史重载不物化、以及从未 settled 的负例；既有失败路径测试不变。
