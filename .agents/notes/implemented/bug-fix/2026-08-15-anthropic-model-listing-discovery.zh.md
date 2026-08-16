# Agent Note: Anthropic 模型列表可被发现

Status: implemented

[English](2026-08-15-anthropic-model-listing-discovery.md) | 中文

## Problem

Models 页的「获取可用模型」动作只能探查 OpenAI 兼容协议：即使 pi-ai 已经为手工声明的路由提供 `anthropic-messages` 协议，`discoverModels` 仍对该协议返回 `DISCOVERY_UNSUPPORTED`。Claude 协议网关或官方端点只能被迫手工录入模型 id，尽管 Anthropic 的 `GET /models` 端点本就公布这些模型，而失败信息也没有给出可行的替代路径。

## Decision

`dsh-llm-pi-ai` 的 discovery 现在可以读取 Anthropic Messages 列表：`GET {baseURL}/models?limit=100`，携带 `x-api-key` 与 `anthropic-version: 2023-06-01` 请求头，按 `has_more`/`last_id` 翻页，上限 20 页（2000 条）。OpenAI 协议保持单页 bearer 行为。可列表协议集合改为按协议分派的表（`ListingProtocol`：URL 构造、请求头、续页游标），两个协议族共享字节上限、`data` 数组解析器（本就读取 Anthropic 的 `id`/`display_name` 条目）、凭据处理与错误映射，包括 401/403 凭据诊断与 `ABORTED` 取消语义。回复声称还有更多页却不带 `last_id` 时直接失败，而非静默截断。

## Alternatives considered

- **只读单页、不做翻页。** 被否决：Anthropic 列表默认只有 20 条，截断会静默漏掉用户预期的模型。
- **像 OpenAI 一样用 bearer 探查 Anthropic。** 被否决：Anthropic 用 `x-api-key` 认证；bearer 探查会得到 401，读起来像凭据问题。
- **保持该协议不可探查。** 被否决：获取动作本就是为目录未收录的网关而存在，Anthropic 的列表与 OpenAI 一样标准化。

## Consequences

Claude 协议网关与官方端点现在能为获取动作返回模型 id 与显示名（不含容量——采纳时保留端点披露的任何字段）。页数上限只在列表无限翻页时触发；畸形续页会大声失败。[草稿提供方端点询问](../../implemented/architecture/2026-08-04-draft-provider-endpoint-interrogation.md) 的决策不变：discovery 始终只是建议性候选，绝不是目录刷新。
