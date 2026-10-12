---
kind: upgrade-guide
description: "跟随工人路由设置的委派子会话会在之后每次请求重新解析 LLM 路由，且该设置在工人运行期间被锁定。"
---

# 工人路由的子会话会重新解析路由

[English](guide.md) | 中文

## 变更

启用 `workerRouteSettings: true` 的 `@deepseek-ai/dsh-tool-subagent` 过去在创建子会话时就把 `subagent-worker-route` 设置固定进去，因此之后的设置改动只作用于下一次委派。由该设置本身路由的子会话现在会记录持久化的 `subagent/worker-route` 标记，之后每次激活（包含冷恢复）都从该设置重新解析 provider、model 与 reasoningEffort，并在下一次请求上追加模型切换告知。调用中自己指名路由或推理档的子会话，以及由未开启该选项的工具行创建的子会话，保持创建时的路由。

同一个插件持有该命名空间的写入守卫：当跟随该设置的工人正在运行时，对 `subagent-worker-route-settings` 的 `settings` `update`、`replace` 与 `mutate` 都会被拒绝——子会话每次请求都重读该设置，改写若落在请求组装期间，就会改变已在发往提供方途中的请求的路由。已结算与失败的工人仍可续聊但不在使用中，而该设置从未路由过的工人保持创建时的路由，因此两者都不持锁。拒绝原因作为该命名空间的 `writeRefusal` 由 `settings` `describe()` 发布，模型设置页依据这个已发布的拒绝原因禁用三个选择器。

## 迁移

1. 无需改动配置。`workerRouteSettings: true` 语义不变：该设置仍是本实例的子级基线路由。
2. 直接写入 `subagent-worker-route-settings` 的脚本或服务必须处理新的拒绝。跟随该设置的工人正在运行时发起的写入会被拒绝并给出该子会话：进程内表现为 `SettingsWriteRefusedError`（`SETTINGS_WRITE_REFUSED`），经 Remote API 时控制器映射为 `settings/rejected`。先调用 `list_agents`，再用控制工具结算或停止该工人后重试。表单可以读取 `settings` `describe()` 里该命名空间的 `writeRefusal`，在尝试之前就禁用控件，而不是等写入被拒。
3. 设置在工人运行时被改动时，该工人会在下一次请求改用存储的路由，而不是保持创建路由。早于该标记事件的读取方会拒绝本版本写出的日志，因此工人会话尚在进行时请让部署停留在同一版本。
4. 升级确认：在没有工人运行时改一次工人路由，续作一个已结算的工人，检查它的对话里是否出现模型切换告知，以及下一次请求是否使用新模型。`pnpm exec vitest run packages/subagent/tool-subagent` 覆盖两个方向。
