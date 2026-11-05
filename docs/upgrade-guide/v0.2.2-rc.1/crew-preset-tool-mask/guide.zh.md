---
kind: upgrade-guide
description: "Crew 角色预设现在对继承来的宿主工具目录做掩码，角色不再看到部署全局注册、而预设未点名的工具。"
---

# Crew 角色预设对宿主工具目录做掩码

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-crew` 的每个预设现在首行都是 `@deepseek-ai/dsh-preset-tool-mask`。它在预设自己的作用域上调用 `tools.restrict()`，因此 `crew`、`crew-worker`、`crew-planner`、`crew-reviewer` 只能看到各自声明保留的全局工具，加上自己行里注册的工具。变更之前，这四个预设继承全部全局工具：审核员身上挂着它人设明确禁止使用的 MCP 文件编辑工具与任务板写入工具。

在 profile 里多挂一个工具插件的部署——MCP 服务器、自研工具行——不再触达 crew 角色，除非该预设点名保留。`crew` 与 `crew-worker` 保留 `mcp__codegraph__*`；`crew-planner` 相同；`crew-reviewer` 保留 `mcp__codegraph__*` 与 MCP 文件系统服务器的读半边（`read`、`list`、`get_file_info`、`search_files`、`directory_tree`）。本版本中，其余工具对这四个预设一律隐藏，且没有开关可以关掉掩码。

宿主自己的 Agent 不受影响：限制只作用于预设作用域，跑 `standard`、`ptc` 或任何自建预设的会话仍持有完整目录。

## 迁移

1. 跑一次角色会话，检查它收到的工具目录。角色缺了它需要的工具，说明预设声明没有点名该工具。
2. 要在某个角色里保留一族全局工具，把名字或前缀加进该预设在 profile patch 里的 `preset-tool-mask` 行。该行接受 `allow`、`allowPrefixes`、`deny`、`denyPrefixes`；任何未被保留的全局名都会被隐藏。
3. 要从已保留的族里剔掉一个成员，把它加进 `deny`。同时出现在 `allow` 与 `deny` 的名字会被剔除，因此「一条宽 `allowPrefixes` 加一条 `deny`」正好表达「这族除了这个」。
4. `allow` 里部署未注册的名字会警告一次并忽略，预设照常挂载，因此共用预设在缺少可选插件的部署里仍然可用。
5. 要恢复某个角色此前的行为，从你的 patch 里删掉该预设的 `preset-tool-mask` 行。该预设重新继承完整目录，它的人设边界回到劝告性质。

用 `dsh --profile <name>` 确认：`crew-reviewer` 会话的工具目录里不再出现 `mcp__filesystem__write_file` 或 `mcp__filesystem__edit_file`；`crew-worker` 会话不再出现部署全局注册、而预设未点名其所属族的工具。
