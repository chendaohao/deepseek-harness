---
description: "把指挥者与三个委派角色——worker、planner、reviewer——组合成 Agent 预设，每个角色解析自己的模型路由。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-crew

[English](README.md) | 中文

## 概述

把指挥者与三个委派角色组合成 Agent 预设：`crew` 是唯一由人选用的预设，它读需求、拆活、派活、核对交付；三个角色预设各由一个委派入口挂载，分别负责实施、出方案、做审核。三个委派行各自读取自己的模型路由命名空间，因此三个角色可以跑在三家不同的模型上。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把本组合包加入 profile 的 `dsh.profile.bundles`，位置在 `@deepseek-ai/dsh-web-app` 之后：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-crew"
      ]
    }
  }
}
```

新建会话时选择 `crew` 预设。它以 **Crew** 出现在预设列表里，排在随附预设之后。

| 预设 | 由人选用 | 角色 |
|---|---|---|
| `crew` | 是 | 指挥者：读需求、拆活、派活、核对交付、向用户汇报 |
| `crew-worker` | 否 | 执行者，持有完整的工作工具集 |
| `crew-planner` | 否 | 写方案，不改代码 |
| `crew-reviewer` | 否 | 给出 PASS 或 FAIL 并附证据，什么都不改 |

每条委派行读取自己的路由命名空间，因此三个角色可以跑在三个不同模型上。在「设置 > 模型」页的工人、规划、审核三个路由块里分别设置；改动在该角色的下一次请求生效，续作与冷恢复一样生效。没有存过路由时，该行回退到它的 `agentOptions` 基线，工人行从 `DSH_CREW_PROVIDER`、`DSH_CREW_MODEL`、`DSH_CREW_EFFORT` 读取。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包的实质是 [cordis.patch.yml](cordis.patch.yml)，由 `dsh.bundle.patch` 声明；模块本身不提供运行时 API。这一层只插入四条 `@deepseek-ai/dsh-agent-preset` 声明，因此依赖 `dsh-web-app` 组合出的 host 面：Agent 预设注册表、`subagentRouteSettings` 注册表，以及三条 `subagent-*-route-settings` 行。命名空间没有对应的行提供服务时，它的委派行会拒绝加载，而不是悄悄路由到另一个角色。

每个角色预设只由它自己的委派行挂载。指挥者的 `delegation` 组里有三条 `tool-subagent` 行；`maxDepth: 1` 把链限制在指挥者下一层。`tool-subagent` 自 2026-10-09 起不再接受 `persona` / `toolFilter` 配置，因此角色的人格与工具只来自它 `agentPreset` 指定的预设。

</details>

<a id="model-experience"></a>
## 模型体验

指挥者看到三个委派工具——`worker`、`planner`、`reviewer`——以及控制行提供的 `send_message`、`list_agents`、`interrupt_agent`。每个角色子会话看到自己预设的工具集，以及一段写明边界的 persona：规划者写方案、审核者判方案，两者都不声称自己改代码。

#### Token 影响

指挥者的 persona 是本组合包里最大的固定开销，它承载了工具定义无法强制的协作规则。角色子会话各自加载自己的预设，不为其他角色的工具付费。

#### KV Cache 影响

角色子会话的工具目录由它的预设固定，因此同一个子会话内的重复请求保持稳定前缀。结算后重新派活会新建子会话，前缀随之重建。

## 已知限制与延期工作

- **三个角色是并列的，不是门禁。** 指挥者可以跳过规划或审核，直接派 worker。方案 PASS 与交付 PASS 的绑定、方案变化后摘要失效、以及让门禁可执行的证据清单，属于另一份交付。
- **角色的「只读」边界是削减，不是限制。** 预设的行只覆盖同名全局工具行，不会移除其余全局工具：规划者与审核者仍继承 `bash`、`write` 以及任何已挂载的 MCP 文件编辑工具。要真正执行该边界，需要在子会话 scope 上调用 `tools.restrict()`，而 `tool-subagent` 已不再接受 `toolFilter` 配置。
- **角色预设会出现在预设列表里。** 注册表没有隐藏标记，因此新建会话时 `crew-worker`、`crew-planner`、`crew-reviewer` 与 `crew` 并列出现；它们的名称与 `order` 标明只用于挂载。
