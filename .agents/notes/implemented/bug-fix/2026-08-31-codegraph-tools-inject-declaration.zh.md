# Agent Note: CodeGraph MCP tools never registered without an inject declaration

Status: implemented

[English](2026-08-31-codegraph-tools-inject-declaration.md) | 中文

## Problem

携带 `.codegraph/` 索引的工作区里，会话能收到 CodeGraph checklist，插件也会拉起 `codegraph serve --mcp`，但在任何部署形态下，任何会话的工具目录里都从未出现过 `mcp__codegraph__*`。故障完全静默：MCP 连接始终健康，守护进程 journal 没有任何输出，checklist 自带的兜底（"没有这些工具就直接用 shell CLI"）还把集成缺失掩盖成了模型行为问题。

原因出在插件的挂载声明上。`@deepseek-ai/dsh-codegraph` 发布时没有 `inject` 导出，而且是刻意的：注释声称 inject 列表会推迟 `apply` 到 tools 服务出现为止，从而"在 bare-context 测试里静默跳过插件"，于是它选择在 sync 时懒解析 `ctx.tools`。Cordis 恰恰拒绝这种访问——插件上下文读取未声明的服务属性会抛 `cannot get property "tools" without inject`。于是每次 `syncTools` 都在注册前抛错；mcp-client 的 contain 路径（`failOnStartupError: false`）返回空代并保持连接不断；又因为连接从未失败，`ready` 正常 resolve，插件"就绪失败后重启"的路径同样永远不会触发。单元测试漏掉它，是因为测试把 `startConnection` 整个 mock 掉了——真实的注册路径从未在测试里运行过。

用真实组件在守护进程外复现（真实 `dsh-tools`、部署里的 gated wrapper、真实的本地 `codegraph serve --mcp`）：checklist 折叠成功，server 拉起且 `tools/list` 返回全部八个工具，而注册表始终为空，抛出的错误只有挂上 logger 钩子才看得见。

## Decision

`@deepseek-ai/dsh-codegraph` 与其它工具插件一样声明自己使用的服务：`export const inject = ['tools']`。未提供 `tools` 的挂载上下文会推迟 `apply` 直到它出现——对一个唯一的服务触点就是工具注册表的插件，这正是正确的激活语义；想启用插件的 bare 组合需要先挂一个注册表。

部署 wrapper（web profile 的 `codegraph-gated.mjs`）以对象插件形式挂载真实插件，而对象插件的 inject 列表来自挂载对象而非被包装模块——所以 wrapper 必须在内层挂载上重申这一要求（`inject: ['tools']`）。两侧现在都携带该声明。

插件测试在挂载插件前先挂真实的 `SystemPrompt` 和 `ToolRuntime`，并新增一条测试锁定该接线：把插件挂进没有工具注册表的上下文时，不折叠 checklist、不启动连接。如果日后有人删掉 `inject` 声明，`apply` 会立即执行，这条测试就会失败。

## Verification

- 修复前探针（真实工具注册表 + gated wrapper + 真实 server）：`mcp-client(codegraph): tool registration failed, no tools registered: Error: cannot get property "tools" without inject`，注册工具为零，连接保持打开。
- 修复后探针，同一组合：八个 `mcp__codegraph__*` 全部注册，且从全局注册表视图可见。
- `packages/codegraph/codegraph/tests`：6/6 通过，含新增的推迟激活测试。
- 重建后的 bundle 在重启后的 web 守护进程里加载；启动审计接受该行（inject 名字无法解析会让启动大声失败）。

## Alternatives considered

**绕过声明解析注册表（把根上下文或注册表引用传进 `startConnection`）。** 否决——cordis 对所有服务解析走同一套 inject 机制，换到哪里写都会照样抛错；传入根上下文会让插件耦合应用根，破坏作用域化挂载。

**只改部署 wrapper。** 否决——wrapper 只是该插件的一个挂载点，其它 profile、bundle 或测试都可能直接挂载；插件必须在自己的边界上满足自己的服务要求。wrapper 之所以仍要重申声明，是因为对象插件挂载的 inject 列表取自挂载对象。

**在 mcp-client 里把"contain 后注册零工具"当作启动失败。** 推迟——contain 路径（仅记日志、`ready` 成功、会话内不重试）确实是这个 bug 藏身的真实缺口，但改 `contain` 语义影响所有 MCP client，应当独立决策；本修复先移除它所掩盖的触发源。

## Consequences

索引工作区的会话现在能在懒连接完成 sync 后的首次请求里看到 codegraph MCP 工具，与 checklist 一直承诺的行为一致。代价：bare 组合必须先挂工具注册表本插件才会激活，且推迟按 cordis 设计是静默的——缺注册表看起来像"插件不存在"，新测试和本笔记让它可诊断。"contain 注册失败静默、会话内不重试"的缺口仍然存在，留给 mcp-client 单独决策。

## Related

- 插件的兜底纪律写在 checklist frame（`packages/codegraph/codegraph/src/checklist.ts`）：先检查 `mcp__codegraph__*`，缺失则退回 shell CLI——在本修复之前，第二步永远落空。
