# @deepseek-ai/dsh-codegraph

[English](README.md) | 中文

面向 dsh 会话的 CodeGraph 集成。

## Behavior

对工作区带有 `.codegraph/` 索引的每个会话：

1. **定向清单** —— 该会话的第一个 pre-step 批次会折入一个 `<system-reminder>` 帧，内含 CodeGraph 清单（`<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->` 之间的符号，每个会话只注入一次）。没有索引的工作区什么也得不到。
2. **MCP 工具** —— 惰性启动一个 `codegraph serve --mcp` 服务器（在第一个带索引的 pre-step 时），其工具注册为 `mcp__codegraph__codegraph_explore`、`codegraph_node`、`codegraph_search` 等。DSH 的 mcp-client 不发送 `rootUri`，因此服务器没有默认项目：代理每次调用都传 `projectPath`（注入的清单中有说明），从而惰性打开任意已索引项目。

连接失败只记日志、绝不致命：代理回退到 `codegraph explore` CLI（清单同样覆盖）。

## Configuration

```ts
export interface Config {
  command?: string       // codegraph CLI executable (default 'codegraph')
  args?: string[]        // extra CLI args after 'serve --mcp' (default [])
  toolCallTimeoutMs?: number // per-tool-call timeout (default 120000)
  enabled?: boolean      // set false to disable (default true)
}
```

## Model Experience

### CodeGraph checklist and tools

#### What the model sees

带索引的工作区、首个回合：会话携带一条额外的用户消息（CodeGraph 清单），工具目录包含 `mcp__codegraph__*`。非索引工作区：无消息、无服务器、无工具。

#### Token effect

每个会话在第一个带索引的 pre-step 注入一条清单消息，外加所挂载 MCP 工具的标准每工具 schema token。

#### KV Cache effect

None; 清单文本与工具 schema 在每个会话内是静态的，本包不做任何缓存专属安排。

## Known Limitations and Deferred Work

- **单一共享服务器** —— `codegraph serve --mcp` 连接是全局的，而非按会话隔离：它在第一个带索引的 pre-step 启动并存活到插件销毁，因此所有带索引的工作区共享它，工具每次调用都需要显式 `projectPath`（DSH 的 mcp-client 不发送 `rootUri`）。
- **CLI 需自行安装** —— 插件从 `PATH`（或配置的 `command`/`args`）解析 `codegraph`，从不固定或下载版本；CLI 缺失或损坏时记一次日志，会话回退到 `codegraph explore` shell 命令。
- **清单只注入一次** —— 清单折入会话中首次出现索引的 `enter` pre-step；后续回合不会重复注入（消息已在 surface 中），索引出现之前的步骤既无指令也无服务器。
