# Agent Note: pi-ai 手写模型获得规范推理回退集

Status: implemented

[English](2026-08-19-pi-ai-canonical-fallback-reasoning-levels.md) | 中文

## Problem

条目未声明 `reasoningEfforts` 的 pi-ai 手写模型——自定义厂商的常见形态——此前以 `reasoning: false` 物化,于是 `getSupportedThinkingLevels` 只返回 `off` 一档,思考等级选择器什么都不提供。一个「会思考但不报告等级」的自定义厂商因此完全无法设置思考等级:控件整体缺席,任何核心无法映射到已声明等级的显式选择都会让请求失败。

## Decision

`resolveModelReasoning` 为没有已安装 catalog 条目、也没有 `reasoningEfforts` 的手写模型报告规范回退集(`off` / `low` / `high` / `max`)。`thinkingLevelMap` 显式 pin 每个等级——`low`/`high`/`max` 携带其规范拼写,`minimal`/`medium`/`xhigh` 为 `null`——这样 pi-ai 不对称的缺省键默认规则(基础等级缺省即支持,`xhigh`/`max` 缺省即不支持)不会把额外等级泄漏进可选项。`off` 保持不在 map 中,pi-ai 将其读作「支持,不发送」:标准的"不思考"词汇。已安装 catalog 条目继续描述其模型,`reasoningEfforts: false` 继续声明不具备推理能力的模型、不提供选择器。

请求路径通过 profile 的 `thinkingFormat` 尽力把规范等级映射到 wire;拒绝该参数的厂商由 [[2026-08-19-normalize-unsupported-reasoning-efforts]] 的请求时降级(Phase C)处理。

## Alternatives considered

- **用 profile 开关门控回退。** 被否:用户的自定义厂商会思考但不声明等级,要点正是无需按模型配置也能让选择器可用;`reasoningEfforts: false` 仍是显式剥除推理的方式。
- **继续把能力报告为不可用。** 被否:这会让思考控件恰恰在用户最需要的模型上缺席。

## Consequences

composer 与 `/model` 弹窗为任何手写自定义模型提供 `off`/`low`/`high`/`max`,选中等级后尽力发到 wire。catalog 模型与显式非推理模型保持不变。pi-ai README 与 `reasoningInfo` JSDoc 改为描述回退集,而非旧的"手写模型不推理"规则。
