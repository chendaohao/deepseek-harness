---
description: "codegraph 组地图：索引工作区的 CodeGraph 集成，面向选择或配置该插件的用户与维护者。"
kind: "package-group"
---

# codegraph/ — CodeGraph 集成

[English](README.md) | 中文

## 概述

codegraph 组将 CodeGraph 代码索引 CLI 集成到工作区带有 `.codegraph/` 索引的 dsh 会话中。由一个包实现：`dsh-codegraph` 在首个 pre-step 批次中折叠注入定向的 CodeGraph 清单，并惰性启动一个 `codegraph serve --mcp` 连接，其工具注册为 `mcp__codegraph__*`。没有索引的工作区什么也不获得——无消息、无服务器、无工具——CLI 缺失或损坏时降级为 `codegraph explore` shell 回退并记录警告，绝不会让会话失败。本页是组地图；包 README 拥有每个包的契约。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`codegraph/`](codegraph/README.zh.md) | 定向 CodeGraph 清单 + 惰性启动的 `codegraph serve --mcp` 连接 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [CodeGraph 包 README](codegraph/README.zh.md) — 每个包的契约、配置与模型体验。
- [配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-codegraph) — 所有可接受的 `dsh-codegraph` 配置值。
- [Agent Note：索引工作区的 CodeGraph 集成](../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.zh.md) — 设计决策与备选方案。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的开放问题与方向。它明确不具权威性——已发布的行为、限制与已接受的理由见上文各节、包代码与链接的 Agent Note。

[CodeGraph 集成功能 note](../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.zh.md) 记录了设计：一个插件落在 agent pre-step waterfall 与 mcp-client 连接 API 两个扩展点上，核心零改动。

</details>
