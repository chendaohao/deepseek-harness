# codegraph/ — CodeGraph 集成

[English](README.md) | 中文

CodeGraph 集成插件：为工作区带有 `.codegraph/` 索引的会话注入定向清单，并惰性启动 codegraph MCP 服务器。**产品**包。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`codegraph/`](codegraph/README.md) | 定向 CodeGraph 清单 + 惰性启动的 `codegraph serve --mcp` 连接 | — |

对非索引工作区该插件完全惰性：无消息、无服务器、无工具。MCP 连接失败时会话回退到 `codegraph explore` CLI（见 [codegraph README](codegraph/README.md)）。
