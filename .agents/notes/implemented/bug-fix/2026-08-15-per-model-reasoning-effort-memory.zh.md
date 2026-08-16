# Agent Note: 显式选择的推理等级按模型路由记忆

Status: implemented

[English](2026-08-15-per-model-reasoning-effort-memory.md) | 中文

## Problem

编辑器中的推理等级选择器与 /model 弹窗在每次选择模型时都会显式带上该模型的 `defaultEffort`，宿主则把每次选择当作完整陈述。因此切换模型总会让新路由解析到自己的默认等级，并丢弃用户此前为上一个路由显式选择的等级；切回时又回到默认。显式选择只存在于「当前选择」之中，从不作为偏好被记住，于是「设置一次、切换后依然生效」无法实现。

## Decision

显式选择的推理等级现在按精确模型路由记忆，持久存放在 `agent-default-model` Settings 分节中，以 `provider/model` 为键的 `reasoningEfforts` 映射保存。线上协议与宿主语义把一次选择的推理维度拆成三种状态：

- 普通模型切换（不带 `reasoningEffort` 的 `session.selectModel`）先按适配器默认解析，若该路由存在记忆且模型仍提供该等级，再用记忆的等级重新解析；路由已不再提供的记忆等级会回退到默认并从记忆中删除。
- 显式等级选择（带 `reasoningEffort`）经校验后记录到解析出的路由上。
- 显式「提供方默认」选择（不带等级、`reasoningEffortExplicit: true`）清除该路由的记忆。

`AgentDefaultModelConfig` 新增 `rememberedEffort`、`rememberEffort`、`forgetEffort`。记忆写入与默认选择保存一样是 best-effort——只读 settings provider 不能让模型切换失败——且 `saveSelection` 保留该映射，因为默认写入会整体替换分节。客户端界面在普通选择时不再携带默认等级：/model 弹窗与编辑器座位只提交路由，推理等级面板则把自己的选择标记为显式，使「省略等级」的含义与之前保持一致。

本决策是对 [adapter-owned reasoning-effort capabilities](../../implemented/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) 的扩展：等级词汇仍由适配器持有、按模型区分，宿主现在只负责回忆显式选择。进程级默认选择仍由 [headless 默认选择入口](../../implemented/architecture/2026-08-09-headless-direct-core-entry-point.md) 持有；记忆是分节中的附加字段，不是第二个默认值。

## Alternatives considered

- **把最近一次选择的等级带到没有记忆的模型上。** 被否决：等级是按模型区分的容量，模型之间可能不一致；跨路由套用最近选择会静默选中用户从未为该模型选过的等级。
- **仅在客户端内存中记忆。** 被否决：刷新页面即丢失全部选择，且宿主本来就把当前选择持久化为默认；Settings 分节是现成的持久化接缝。
- **把按模型映射存进会话。** 被否决：会话按对话隔离，而问题跨会话存在；部署级 Settings 分节与默认选择现有的存放位置一致。

## Consequences

显式选择的推理等级现在能跨模型切换与刷新存活，并且每个路由保留各自的选择；切到没有记忆的路由时仍显示该模型的默认等级。`session.selectModel` 载荷新增一个可选线上字段（`reasoningEffortExplicit`）。推理等级记忆是部署级的（所有会话共享），与现有默认选择的范围一致。过期的记忆等级可自愈：宿主在该路由下一次普通切换时将其丢弃。
