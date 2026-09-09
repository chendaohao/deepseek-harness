---
description: "CodeGraph integration plugin: scoped checklist and lazily started MCP server for indexed workspaces, for users and maintainers mounting or configuring it."
kind: "package-reference"
---

# @deepseek-ai/dsh-codegraph

English | [中文](README.zh.md)

## Summary

For every session whose workspace carries a `.codegraph/` index, `dsh-codegraph` folds a CodeGraph checklist into the first pre-step batch and lazily starts one `codegraph serve --mcp` connection whose tools register as `mcp__codegraph__*`. Workspaces without an index get nothing: no message, no server, no tools. Connection failures are logged and never fatal — the checklist tells agents to fall back to the `codegraph explore` CLI, and a failed connection is discarded and restarted on the next session's first indexed pre-step. The connection is global, not per-session: DSH's mcp-client sends no `rootUri`, so agents pass `projectPath` per call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when agents work in repositories that carry a `.codegraph/` index and should consult it before reaching for `grep`/bulk `Read` on code questions. There is nothing to learn or wire: the plugin is inert for non-indexed workspaces, and a missing or broken `codegraph` CLI degrades to the shell fallback with a logged warning.

### Configuration

Mount the plugin with optional configuration:

```yaml
- name: '@deepseek-ai/dsh-codegraph'
  config:
    command: codegraph        # codegraph CLI executable (default 'codegraph')
    args: []                  # extra CLI args after 'serve --mcp' (default [])
    toolCallTimeoutMs: 120000 # per-tool-call timeout (default 120000)
    enabled: true             # set false to disable entirely (default true)
```

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-codegraph) documents every accepted value.

### What you get

Indexed workspace, first turn: the session carries one additional user message with the CodeGraph checklist, and the tool catalog includes `mcp__codegraph__*` once the lazily started connection settles. Until then (or when startup failed), the checklist directs the model to the `codegraph explore` shell fallback. Non-indexed workspace: no message, no server, no tools.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin mounts two existing seams with no core changes:

1. **Scoped checklist** — the first `enter` pre-step batch folds in a `<system-reminder>` frame with the CodeGraph checklist (symbols between `<!-- CODEGRAPH_START -->` / `<!-- CODEGRAPH_END -->`, injected once per session; the message is a durable `codegraph-instructions` source so replay and dedupe work). The checklist never asserts the MCP server is mounted: it tells the model to check whether `mcp__codegraph__*` is in the tool catalog and, when it is not, to go straight to the `codegraph explore` shell fallback.
2. **Lazy MCP server** — the first indexed pre-step spawns one `codegraph serve --mcp` child through the existing mcp-client connection API with a reconnect policy and a per-tool-call timeout; its tools register as `mcp__codegraph__*`. Because the mcp-client supervisor gives up permanently once its reconnect budget is exhausted, a failed connection is discarded and re-spawned on the next session's first indexed pre-step — a transient codegraph daemon outage does not disable the MCP tools for the rest of the web lifetime.

The connection is global: DSH's mcp-client sends no `rootUri`, so the server has no default project and agents pass `projectPath` per call — which opens any indexed project lazily, in any workspace. The CLI binary is never pinned or downloaded (PATH or an explicit `command`).

-----

<a id="model-experience"></a>
### Invariant ownership

No runtime invariant companion is published because the checklist folding and MCP server registration are covered by the package's tests; no owned relation needs a boot-time recheck.

## Model Experience

### CodeGraph checklist and tools

#### What the model sees

Indexed workspace, first turn: the session carries one additional user message with the CodeGraph checklist, and the tool catalog includes `mcp__codegraph__*` once the lazily started connection settles. Until then (or when startup failed), the checklist directs the model to the `codegraph explore` shell fallback. Non-indexed workspace: no message, no server, no tools.

##### CodeGraph checklist frame

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

#### Token effect

One checklist message per session on the first indexed pre-step, plus the standard per-tool schema tokens of the mounted MCP tools.

#### KV Cache effect

Append-only; the checklist text and tool schemas are static per session and follow the reusable request prefix without invalidating existing entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **One shared server** — a single `codegraph serve --mcp` connection is global, not per-session: it starts on the first indexed pre-step and lives until plugin disposal, so every indexed workspace shares it and tools need an explicit `projectPath` per call (DSH's mcp-client sends no `rootUri`).
- **CLI is assumed installed** — the plugin resolves `codegraph` from `PATH` (or the configured `command`/`args`) and never pins or downloads a version; a missing or broken CLI is logged once and sessions fall back to the `codegraph explore` shell command.
- **Checklist is one-shot** — the checklist folds into the first `enter` pre-step of a session whose workspace carries an index at that point; later turns never re-inject it (the message already sits in the surface), and steps before an index exists get neither instructions nor a server.
- **Best-effort MCP startup** — the server starts asynchronously on the first indexed pre-step; the first turn's tool catalog may miss the tools while the connection settles, and a failed startup leaves the session with the shell fallback (the checklist is explicit about this). The connection is restarted once per later session until it succeeds or the plugin reloads.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [CodeGraph integration feature note](../../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.md) records the design and alternatives.

</details>
