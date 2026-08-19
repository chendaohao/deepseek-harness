# Agent Note: 不支持的思考等级归一化到模型默认值

Status: implemented

[English](2026-08-19-normalize-unsupported-reasoning-efforts.md) | 中文

## Problem

输入框的思考等级选择器和 `/model` 弹窗按模型选择适配器拥有的思考等级。自定义模型厂商往往不声明其思考等级(`reasoningEfforts` 在 pi-ai 手写路由上缺省),也不会回传实际使用的等级,于是 harness 唯一的信号就是请求本身。选择模型未声明的等级此前会在 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 被拒绝——选择失败弹 toast,请求根本不会发出。对于"会思考但不报告等级"的厂商,这让思考等级控制完全不可用:未声明模型不提供选择器,任何目录未覆盖的显式选择都会直接失败。

## Decision

`LlmRuntime.resolveCallFor` —— `selectModel` 与 `prepareCall` 共享的唯一点 —— 将模型不支持的显式等级归一化,而不是拒绝。回退链为:请求的等级 → 模型声明的适配器 `defaultEffort`(若有)→ 丢弃等级让厂商自己的默认值生效。配置绝不 alias 到任意等级;解析只会落在适配器声明的等级上,或不发。

这是对 [[2026-07-24-adapter-owned-reasoning-effort-capabilities]] "never clamp or alias" 规则的定向放宽。适配器仍然拥有其 wire 词汇:核心在适配器看到之前把模型声明集合外的等级归一化,各适配器仍拒绝其无法在 wire 上拼写的等级。

## Alternatives considered

- **继续拒绝不支持的等级。** 被否:一个会思考但不声明等级的自定义厂商永远无法使用思考等级控制;任何乐观或过期的选择都会让整次选择失败。
- **只对未声明推理能力的模型归一化。** 被否:这会按能力形态分裂解析语义——目录条目落后于真实能力的模型与手写模型应获得同样的回退。

## Consequences

`selectModel` 与 `prepareCall` 解析为归一化后的等级(或无),而不是失败,`request/header` 记录该解析值,保证模型可见的请求可重建。`thinking: disabled` 的 DeepSeek 部署只提供 `off`,显式的更高等级会归一化到它,请求仍禁用思考。断言拒绝的测试改为断言回退链;客户端对比请求等级与解析等级,向用户暴露归一化。
