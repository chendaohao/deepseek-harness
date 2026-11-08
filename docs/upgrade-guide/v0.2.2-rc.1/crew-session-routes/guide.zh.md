---
kind: upgrade-guide
description: "编队模型组合变成模板库，由新建会话复制一份；模型页因此不再写三个角色的路由命名空间。"
---

# 编队路由改为按会话选择

[English](guide.md) | 中文

## 变更

模型页的编队区块不再编辑三个角色的路由命名空间，而是编辑**组合库**：先选一套组合，再选三个角色之一，编辑该角色的提供方、模型与思考等级，然后保存。保存只写 `subagent-route-presets` 这一条设置。

新建 crew 会话时在预设旁选一套组合，这个选择记在该会话上：

会话日志会在它的首轮之前追加这个事件：

```jsonc
{ "type": "crew/routes-selected", "data": { "presetId": "preset-1", "presetName": "Deep review", "routes": { "worker": { … }, "planner": { … }, "reviewer": { … } } } }
```

每条委派行按「会话记录的路由，否则该行自己的命名空间」解析路由。由此：

1. **改组合不再影响已建会话。** 记录过组合的会话保持原样。需要修复路由时，用会话头部的「换路」只替换该角色；修改组合库不会改变已有会话。
2. **编辑不再被运行中的角色挡住。** 写入只进组合库，没有委派直接读它；只有按会话的单角色修复会被锁。
3. **委派失败按角色单独修复。** `crew/route-replaced` 记录一个角色的新路由，保留另外两个，并让该会话不再匹配它原本的组合。
4. **没记录过路由的会话继续读角色命名空间**，所以从不开选择器的入口——CLI、API、旧客户端——行为不变。
5. **记录是一次性的首选声明。** 重复选择会话已带的同一组合幂等成功且不再写事件；会话已记录另一组合时，选择不同组合会以 `crew/conflict` RemoteError（携带 `recordedPresetId`、`attemptedPresetId`）失败且不改变任何记录；客户端保留已选组合并显示错误，而不是静默回退到角色默认路由。
6. **角色 turn 有执行预算。** `crew-formation.budget` 限制步数、时长、总 token 和连续相同的工具失败。达到上限会记录 `crew/run-budget-exceeded`；新的续作 turn 会重新计算预算。

设置项保留两条，新增一条：

```yaml
- id: subagent-route-presets
  name: '@deepseek-ai/dsh-tool-subagent/route-presets'
- id: crew-formation
  name: '@deepseek-ai/dsh-crew/formation'
  config:
    worker: subagent-worker-route-settings
    planner: subagent-planner-route-settings
    reviewer: subagent-reviewer-route-settings
```

## 迁移

1. 选 `@deepseek-ai/dsh-crew` 后重启：bundle 插入 `crew-formation` 行，区块从三行角色改成一套组合编辑器。
2. 用户此前通过角色行设过的路由，仍是未记录组合的会话的回退值。把它们在模型页存成一套组合即可供选择。
3. 已存的空白 crew 会话照常续接：它没记录路由，因此它的委派在换成一次带选择的会话之前仍读角色命名空间。
4. `crewFormation` Remote 命名空间（`view`、`selectRoutes`、`replaceRole`）是新增的；早于此版本的客户端不会调用它，无需改动。带 endpoint 白名单的 viewer 客户端需要给这三个端点分类。
5. `@deepseek-ai/dsh-crew`、`@deepseek-ai/dsh-tool-subagent` 与客户端要一起升级：会话复制下来的路由由委派行读取，旧的 `tool-subagent` 会忽略它。
6. 组合应用失败的首轮不会进入会话：composer 放弃提交回执、保留草稿，并显示组合自身的失败原因。客户端与 Host 一起升级，才能保证被拒绝的组合不会让会话静默跑在角色默认路由上。
7. 额度或预算停止后，在原有会话头部选择替换路由并确认。换路不会自动重试；之后让指挥续作原子代理。只有明确需要更大预算时才调整 `crew-formation.budget`。
8. 自定义组合必须在 `crew-formation` 前挂载 `@deepseek-ai/dsh-token-meter`，并在 `tool-subagent` 前挂载 `@deepseek-ai/dsh-session`；角色预算和子会话路由恢复依赖这两个服务。标准 bundle 已提供它们。
9. 直接使用 `crew-worker`、`crew-planner` 或 `crew-reviewer` 创建会话或调用 `agentPresets.select` 会以 `agent-preset/invalid` 失败。请改为启动 `crew` preset，再委派给这些内部角色。
