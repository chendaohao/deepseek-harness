---
kind: upgrade-guide
description: "Claude Code 钩子桥接包更名为 @deepseek-ai/dsh-notify-hooks；钩子配置、行为与会话生产源 kind 均不变。"
---

# 钩子桥接现已更名为 `dsh-notify-hooks`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-hooks-claude-code` 更名为 `@deepseek-ai/dsh-notify-hooks`。该包仍在同一批拦截扩展点上运行 Claude Code `hooks.json` 或 settings 钩子配置——SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 及子会话起止边——配置项、钩子载荷、判定与超时均不变。Cordis 插件名从 `hooks-claude-code` 改为 `notify-hooks`，携带插件名的日志行随新名。会话数据与钩子配置无需改写：桥接注入上下文所盖的生产源 kind 仍为 `"hooks-claude-code"`——这是已发布的会话格式身份，本次更名刻意保持其稳定。

## 迁移

1. 按包名挂载的 `cordis.yml` 或 patch 行必须改用 `@deepseek-ai/dsh-notify-hooks`；拼写旧包名的行 id 宜在同一处改动中更名。`dsh plugin add @deepseek-ai/dsh-notify-hooks` 安装新包名。
2. 工作区 `package.json`、import 或 `tsconfig` 路径中命名 `@deepseek-ai/dsh-hooks-claude-code` 的位置必须改为 `@deepseek-ai/dsh-notify-hooks`；本次发布后旧名无法解析。
3. 会话数据与钩子配置原样保留：桥接继续发出生产源 kind `"hooks-claude-code"`，读取方与已录制会话无需改动。
4. 确认升级：挂载插件、结束一个回合，并在会话日志中检查 `Stop` 点的 `hook/invoked` 与 `hook/result` 一对事件。`pnpm exec vitest run packages/experimental/notify-hooks` 覆盖该桥接。
