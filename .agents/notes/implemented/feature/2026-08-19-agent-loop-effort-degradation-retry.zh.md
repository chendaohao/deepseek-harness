# Agent Note: 内置请求错误回退降级被拒绝的推理等级

Status: implemented

[English](2026-08-19-agent-loop-effort-degradation-retry.md) | 中文

## Problem

携带显式推理等级、但被提供方拒绝的请求——自定义厂商以校验类错误拒绝 `reasoning_effort` 参数——会让整轮失败:内置 `agent/request-error` 回退只能以完全相同的配置重试,没有插件的部署没有任何可改变的东西。[[2026-08-19-normalize-unsupported-reasoning-efforts]] 的等级归一化让选中的等级可以解析,但厂商在 wire 上拒绝该参数仍会打断对话。

## Decision

内置 `agent/request-error` 回退在请求携带等级、且失败是合理的等级拒绝——`INVALID_REQUEST`/`HTTP_400`,或措辞点名 `reasoning`/`thinking`/`effort`——时,每 step 丢弃一次推理等级并重试。`RequestErrorAction` 增加可选 `dropReasoningEffort`;`agent/request` 瀑布 payload 增加 `degradedEffort`,让会重新注入继承等级的监听器(模型选择中间件)在降级重试时跳过。`buildRequest` 同样从其 seed 配置剥离等级,以覆盖未挂载选择中间件的部署。降级重试记录自己的 `request/header`,保证被丢弃的参数可重建。

选择本身不变:用户选择的等级仍留在会话上,只有这次重试省略它。再次失败会暴露原始错误;每 step 一次的上限防止无限降级循环。

## Alternatives considered

- **在适配器内重试。** 被否:适配器没有循环/会话上下文来重新分发,把配置变更塞进传输重试会混淆两个关注点。
- **以相同配置重试。** 是此前内置回退唯一的动作;无法修复被提供方拒绝的参数。

## Consequences

无插件部署在显式等级被厂商拒绝后,以提供方自己的默认值重试,从而完成一轮。降级重试是瀑布的最后一招——返回恢复动作的插件仍拥有重试。测试覆盖降级路径与不降级路径(`RATE_LIMIT` 不是等级拒绝)。
