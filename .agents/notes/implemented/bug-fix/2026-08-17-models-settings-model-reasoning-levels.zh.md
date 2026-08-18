# Agent Note：Models 设置页的自定义 pi-ai 模型行可声明思考等级

Status: implemented

[English](2026-08-17-models-settings-model-reasoning-levels.md) | 中文

## Problem

Models 设置页无法为自定义提供方配置思考等级。pi-ai 适配器在其逐模型推理工作中就支持了按模型的 `reasoningEfforts`，但设置 UI 的模型行只编辑 `id`/`name`/`contextWindow`/`maxTokens`。因此通过「添加自定义提供方」声明的提供方只能在 `settings.yaml` 中手写才能提供思考档位；composer 的选择器对这类模型只能看到适配器默认值。提供方级的 effort 控件此前被刻意移除，因为 effort 是按模型的能力、同一提供方下各模型的档位不一致——但按模型设置它的位置一直没有被提供。

## Decision

每个 pi-ai 模型行的展开区新增思考声明编辑器，三种模式：

- **继承**（默认）：不写 `reasoningEfforts` 字段。手工声明的模型不思考；catalog 模型保留其 catalog 能力。
- **不思考**：存 `false`。
- **自定义等级**：逐级组装一个 dict。勾选某档位即写入（新勾选的档位默认以自身作为 wire 值，可按网关修改）；`off` 可留空——存为 `null`，表示「支持且不发送参数」——其余每个已声明档位需要非空的 wire 值。

等级词汇读自所属 namespace 的 schema（与 `protocolChoices` 同一条 schema 读取路径，取 dict 的 `sKey` union），因此 UI 提供的档位不会与 `resolveModelReasoning` 接受的集合漂移。保存前由同一套逐行检查把关：声明至少提供一个 `off` 之外的档位，除 `off` 外的每个已声明档位必须给出 wire 值。`ModelListEditor` 被自定义提供方创建卡片与提供方编辑器共用，因此两个界面同时获得该控件；编辑模型列表的内置（catalog）pi-ai 路由同样受益。

## Alternatives considered

- **重新引入提供方级 effort 控件。** 拒绝：此前的移除理由仍然成立——提供方级的值会被部分模型拒绝，并让整个提供方因一行错误从选择器中消失。
- **在客户端硬编码等级词汇。** 拒绝：适配器的 `Config` 才是权威；schema 读取让 UI 与适配器不漂移，与既有 `protocolChoices` 模式一致。

## Consequences

自定义提供方的模型现在可以从 Models 设置页声明可选的思考档位，composer 的 effort 面板为这些模型提供恰好声明的档位（及其 wire 拼写）。`reasoningEfforts` 字段仍归适配器所有、按模型配置；新的只是编辑界面。DeepSeek 家族的模型行不变，因为 `llm-deepseek` 没有按模型的推理字段——它的 thinking/effort 设置是连接级默认。
