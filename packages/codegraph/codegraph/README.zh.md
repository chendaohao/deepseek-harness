---
description: "CodeGraph 集成插件：索引工作区的定向清单与惰性启动的 MCP 服务器，面向挂载或配置它的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-codegraph

[English](README.md) | 中文

## 概述

对每个工作区带有 `.codegraph/` 索引的会话，`dsh-codegraph` 在首个 pre-step 批次中折叠注入 CodeGraph 清单，并惰性启动一个 `codegraph serve --mcp` 连接，其工具注册为 `mcp__codegraph__*`。没有索引的工作区什么也不获得：无消息、无服务器、无工具。连接失败会记录日志且绝不致命——清单指示代理回退到 `codegraph explore` CLI，失败连接会被丢弃并在下一个会话的首个带索引 pre-step 重启。连接是全局的而非按会话：DSH 的 mcp-client 不发送 `rootUri`，因此代理每次调用都传 `projectPath`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当代理在带有 `.codegraph/` 索引的仓库中工作、且应在代码问题上优先于 `grep`/批量 `Read` 查阅索引时，挂载本插件。无需学习或接线：插件对非索引工作区完全惰性，`codegraph` CLI 缺失或损坏时降级为 shell 回退并记录警告。

### 配置

挂载插件时可带可选配置：

```yaml
- name: '@deepseek-ai/dsh-codegraph'
  config:
    command: codegraph        # codegraph CLI executable (default 'codegraph')
    args: []                  # extra CLI args after 'serve --mcp' (default [])
    toolCallTimeoutMs: 120000 # per-tool-call timeout (default 120000)
    enabled: true             # set false to disable entirely (default true)
```

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-codegraph)记录了所有可接受的值。

### 你将获得

带索引工作区，首轮：会话携带一条附加的含 CodeGraph 清单的用户消息，工具目录在惰性连接就绪后包含 `mcp__codegraph__*`。在此之前（或启动失败时），清单指示模型使用 `codegraph explore` shell 回退。非索引工作区：无消息、无服务器、无工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件挂载两个既有扩展点，核心零改动：

1. **定向清单** — 首个 `enter` pre-step 批次折叠注入 `<system-reminder>` 框架，内含 CodeGraph 清单（`<!-- CODEGRAPH_START -->` 与 `<!-- CODEGRAPH_END -->` 之间的符号，每个会话注入一次；消息是持久的 `codegraph-instructions` 来源，因此重放与去重可用）。清单从不断言 MCP 服务器已挂载：它指示模型检查工具目录中是否有 `mcp__codegraph__*`，没有时直接使用 `codegraph explore` shell 回退。
2. **惰性 MCP 服务器** — 首个带索引 pre-step 通过既有 mcp-client 连接 API 生成一个 `codegraph serve --mcp` 子进程，带重连策略与每次工具调用超时；其工具注册为 `mcp__codegraph__*`。由于 mcp-client 监督者在重连预算耗尽后永久放弃，失败连接会被丢弃并在下一个会话的首个带索引 pre-step 重新生成——一次瞬时 codegraph 守护进程故障不会在 web 生命周期的其余时间里禁用 MCP 工具。

连接是全局的：DSH 的 mcp-client 不发送 `rootUri`，因此服务端没有默认项目，代理每次调用传 `projectPath`——这会惰性打开任意已索引项目，任意工作区皆可。CLI 二进制从不固定或下载（PATH 或显式 `command`）。

-----

<a id="model-experience"></a>
### 不变量归属

未发布运行时不变量伴生文件，因为清单折叠与 MCP 服务器注册已由本包测试覆盖；没有需要在启动时复核的所属关系。

## 模型体验

### CodeGraph 清单与工具

#### 模型所见

带索引工作区，首轮：会话携带一条附加的含 CodeGraph 清单的用户消息，工具目录在惰性连接就绪后包含 `mcp__codegraph__*`。在此之前（或启动失败时），清单指示模型使用 `codegraph explore` shell 回退。非索引工作区：无消息、无服务器、无工具。

##### CodeGraph 清单框架

```markdown
<system-reminder>
A `.codegraph/` index exists for this workspace. Follow the CodeGraph checklist below before reaching for Read/grep on code questions.

<!-- CODEGRAPH_START -->
## CodeGraph

**CodeGraph 优先原则**

1. 当前工作区存在 `.codegraph/` 时，优先使用 CodeGraph 定位代码、调用链或影响面：
   - 有 `mcp__codegraph__*` 工具 → 调用它们，**每次传 `projectPath: <当前工作区绝对路径>`**；首选 `codegraph_explore`，深度查询用 `codegraph_node`，全文检索用 `codegraph_search`。
   - 没有 MCP 工具或调用失败 → 直接执行 shell 命令 `codegraph explore \"<符号或问题>\"`，不要等待重试。
2. 只有以下情况才回退到 `grep` / `find` / `Read`：
   - 需要完整文件内容（CodeGraph 只返回摘要或片段）；
   - 需要执行命令（测试、构建、lint、扫描等）；
   - 需要外部信息（文档、CVE、依赖版本等）；
   - CodeGraph 工具不可用或返回结果不完整。
3. 委托 `explore` / `code-reviewer` / `security-reviewer` 等子代理时，将以上两条规则原样写入其提示词开头，并要求其在报告中注明哪些结论来自 CodeGraph，哪些来自 `Read` / `grep`。

### Subagent convention

When delegating `code-reviewer`, `security-reviewer`, `critic`, `explore`, or similar subagents for code review or architecture work, prepend the same `.codegraph/`-first discipline to their prompt. Their final report should note which findings came from codegraph vs `Read` / `Bash` / `grep`.
<!-- CODEGRAPH_END -->
</system-reminder>
```

#### Token 影响

每个会话在首个带索引 pre-step 有一条清单消息，加上已挂载 MCP 工具的标准逐工具 schema token。

#### KV Cache 影响

追加式；清单文本与工具 schema 在每个会话中是静态的，跟随可复用的请求前缀且不使既有条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了插件不适合的场景。它们是当前包约束，而非任务积压。

- **单一共享服务器** — 单个 `codegraph serve --mcp` 连接是全局的而非按会话：它在首个带索引 pre-step 启动并存活到插件释放，因此每个带索引工作区共享它，工具每次调用需显式 `projectPath`（DSH 的 mcp-client 不发送 `rootUri`）。
- **假定已安装 CLI** — 插件从 `PATH`（或配置的 `command`/`args`）解析 `codegraph`，从不固定或下载版本；CLI 缺失或损坏时记录一次日志，会话回退到 `codegraph explore` shell 命令。
- **清单一次性** — 清单折叠进工作区当时带索引的会话的首个 `enter` pre-step；后续轮次绝不重新注入（消息已位于 surface），索引存在之前的步骤既无指令也无服务器。
- **尽力而为的 MCP 启动** — 服务器在首个带索引 pre-step 异步启动；连接就绪期间首轮工具目录可能缺少工具，启动失败后会话只剩 shell 回退（清单对此明确说明）。连接在之后的每个会话重启一次，直到成功或插件重载。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：未决的开放问题与方向。它明确不具权威性——已发布的行为、限制与已接受的理由见上文各节、包代码与链接的 Agent Note。

[CodeGraph 集成功能 note](../../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.zh.md) 记录了设计与备选方案。

</details>
