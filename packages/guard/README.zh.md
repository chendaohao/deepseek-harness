---
description: "循环卫生 guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略、有界的触顶恢复，以及编译命令串行化器，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组通过监视常见失败模式来保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 用建议打断完全相同的工具调用循环。`timeout-policy` 让挂起的工具调用得到清晰的超时错误，而不是拖住整个会话。`max-tokens-recovery` 用一个有界的恢复提示回应「把全部输出预算花在推理上」的 turn，使 agent 不会无声停摆。`compile-serialization` 同一时刻只放行一条编译类命令，使同一检出目录里的并发 worker 不会互相覆盖构建产物。前三个随 `dsh` 基础组合包默认启用；`compile-serialization` 默认关闭，因为它是拒绝而非排队。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

小巧而独立的插件各自覆盖一种模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`max-tokens-recovery/`](max-tokens-recovery/README.zh.md) | 当一个 turn 把全部输出预算烧在推理上时，排入一次有界的恢复提示 |
| [`compile-serialization/`](compile-serialization/README.zh.md) | 同一时刻只放行一条编译类命令，使并发 worker 不会互相覆盖构建产物 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——两个 guard 都依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-compile-serialization)——编译命令串行化器的每个受支持字段。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
