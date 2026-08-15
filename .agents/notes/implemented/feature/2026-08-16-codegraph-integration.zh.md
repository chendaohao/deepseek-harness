# Agent Note: 面向索引工作区的 CodeGraph 集成

Status: implemented

[English](2026-08-16-codegraph-integration.md) | 中文

## Problem

大型仓库很难单靠 grep 导航：调用链、结构、影响面都藏在符号关系后面。codegraph CLI 暴露了这份索引，但没有引导时 agent 永远不会去用它——工具存在，习惯不存在。仓库需要按工作区定向的指令面，加上能打开任意已索引项目的工具。

## Decision

**一个插件 `dsh-codegraph`，落在两个既有扩展点上——agent pre-step waterfall 与 mcp-client 连接 API——核心零改动。**

- **定向清单。** 对工作区带有 `.codegraph/` 索引的每个会话，第一个 `enter` pre-step 批次折入一个 `<system-reminder>` 帧，内含 CodeGraph 清单（`<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->` 之间的符号，每会话只注入一次；消息是持久的 `codegraph-instructions` source，回放与去重均可工作）。没有索引的工作区什么也得不到：无消息、无服务器、无工具。
- **惰性 MCP 服务器。** 第一个带索引的 pre-step 通过既有 mcp-client 连接 API 启动一个 `codegraph serve --mcp` 子进程，带重连策略与每工具调用超时；其工具注册为 `mcp__codegraph__codegraph_explore`、`codegraph_node`、`codegraph_search` 等。DSH 的 mcp-client 不发送 `rootUri`，因此服务器没有默认项目，代理每次调用都传 `projectPath`——从而惰性打开任意已索引项目。连接失败只记一次日志、绝不致命：会话回退到 `codegraph explore` CLI。
- **配置** `{command?, args?, toolCallTimeoutMs?, enabled?}` 走标准 Config schema 校验；CLI 二进制从不固定或下载（PATH 或显式 command）。

## Alternatives considered

- **常驻服务器**——否决：按第一个带索引的 pre-step 惰性启动一个子进程足够；常驻会浪费非索引会话的资源。
- **按会话的服务器**——否决：连接是全局的，因为 mcp-client 不带 rootUri；按会话隔离只会平白增加子进程。
- **仅提示词集成**——否决：没有 MCP 工具时清单会指向不存在的工具；该 seam 要么指令加工具，要么什么都没有。

## Consequences

- 索引会话的首个回合多携带一条用户消息（清单），工具目录包含 `mcp__codegraph__*`；模型体验记录在包 README 中。
- codegraph CLI 缺失或损坏时降级到 shell 回退并记警告日志——插件绝不会让会话失败。
- 清单只注入一次：后续回合不会重复注入（消息已在 surface 中）。
