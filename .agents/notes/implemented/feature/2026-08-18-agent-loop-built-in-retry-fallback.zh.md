# Agent Note：request-error 瀑布的内置重试兜底

Status: implemented

[English](2026-08-18-agent-loop-built-in-retry-fallback.md) | 中文

## Problem

重试失败的模型请求需要挂载监听 `agent/request-error` 的插件。没有任何 listener 时，瀑布最终的 `next()` 默认值会让每个提供方失败保持终态，即使服务该请求的适配器注册携带了已解析的 `retryPolicy`。因此，只挂载适配器而不挂载恢复插件的组合，会为每一次瞬时提供方错误付出一个失败轮次的代价，而 Claude Code 会透明地重试。

## Decision

`agent/request-error` 瀑布的内置兜底——仅在每个 listener 都委托后才会运行的 `next()` 尾部——直接应用服务该请求的适配器的已解析重试策略：

- 没有服务策略的请求（`retryPolicy` 为 undefined，例如从未到达最终适配器边界）保持终态。
- `mode: 'always'` 无尝试上限地重试每一次失败，直到成功、取消或 agent 被销毁。
- normal 模式重试失败码列在 `retryableCodes` 中的失败，每步最多 `maxRetries`（默认 2）次，之后保持终态。

每步一个重试计数器，在每一步开始时重置，且只有内置兜底自身决定重试时才递增。`@deepseek-ai/dsh-llm-retry`——挂载时在瀑布中更早运行、可向下游委托——通过 `llm/retry` 会话事件维护自己的计数，因此它的预算与兜底的预算永不共享状态。兜底的重试会立即重试同一个步骤：没有退避、没有 `llm/retry` 事件、不关闭轮次。失败的 chunk 是非 surface 事件，永远不会进入重建请求的派生消息。

## Alternatives considered

- **让瀑布默认值保持终态**（维持原状）——拒绝：可重试性是服务适配器已经携带的策略；在精简组合中拒绝执行它，会把每一次瞬时失败都变成失败轮次。
- **在循环中复制插件的退避与重试事件**——拒绝：`dsh-llm-retry` 存在的意义正是为需要有限指数退避、尊重提供方延迟和持久重试历史的部署服务；在循环中复制它会把重试预算拆成两个没有共享历史的计数器。

## Consequences

精简组合无需恢复插件即可从瞬时失败中恢复，与 Claude Code 的透明重试一致。兜底自身不写入任何事件——每次重试的 chunk 仍是 trace/replay 记录，重试的请求仍是普通的模型可见请求，因此「模型可见 ⟺ 已记录」不变量不变。`maxRetries` 是每步预算：多步轮次在每一步都花费全新的预算。需要退避、重试事件或跨部署历史的部署仍会挂载 [dsh-llm-retry](2026-07-24-provider-retry-policies.md)，它先运行，兜底不会被触达。
