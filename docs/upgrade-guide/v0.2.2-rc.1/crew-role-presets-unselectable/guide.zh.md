---
kind: upgrade-guide
description: "预设可以声明 userSelectable: false，编队三个角色预设因此不再出现在新建会话选择器里，也不能再用来开会话。"
---

# 编队角色预设不再可选

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-agent-preset` 接受一个新的可选字段 `userSelectable`。它默认为 true；声明 `false` 的预设只由另一个预设的组合挂载，绝不自己开一个会话。

编队 bundle 用它在三个委派角色上做了声明：

```yaml
- id: preset-crew-worker
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: crew-worker
    name: Crew Worker
    order: 99
    userSelectable: false
    description: 'Crew executor preset, mounted by the crew preset''s worker tool; not for creating sessions.'
```

有两处界面按它过滤，一处拒绝：

1. 新建会话的预设选择器与预设页只提供标记缺失或为 true 的预设。坏掉的内部预设仍然可见，因为那是需要有人看见的部署故障。
2. 用 `userSelectable: false` 的预设调用 `session.create` 会被以 `agent-preset/invalid` 拒绝。此前它会创建一个会话，跑着角色人格却没有上级指挥者，也就是静默地没有委派对象。
3. `AgentPresetRow.userSelectable` 把标记带到客户端。普通预设省略该字段，所以忽略它的既有客户端行为完全不变。

内部挂载不受影响：`tool-subagent` 行按 `agentPreset` id 点名角色，经 `mount` 进入注册表，那条路径从不读这个标记。

## 迁移

1. 选择 `@deepseek-ai/dsh-crew` 后重启：选择器与预设页只列出 **Crew**，两份 README 表格也已写明。
2. 从没在 `session.create` 里点名 `crew-worker`、`crew-planner`、`crew-reviewer` 的部署无需改动。点名过的现在会收到 `agent-preset/invalid`；改为开一个 `crew` 会话再委派，因为角色自己没有委派工具。
3. 只作为 `tool-subagent` 的 `agentPreset` 目标使用的外部预设，建议声明 `userSelectable: false` 让它离开选择器。不写就保持今天的行为，同样有效。
4. 已经建在角色预设上的空白会话不受影响：续接它读的是记录下来的预设，不是名册标记。
