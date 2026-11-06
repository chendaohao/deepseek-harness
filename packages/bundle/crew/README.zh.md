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

每条委派行读取自己的路由命名空间，因此三个角色可以跑在三个不同模型上。这些命名空间由本 bundle 提供，所以只有选择了本 bundle 的 profile 才在「设置 > 模型」页显示编队路由块。在其中按工人、规划、审核三行分别设置；改动在该角色的下一次请求生效，续作与冷恢复一样生效。没有存过路由时，该行回退到它的 `agentOptions` 基线，工人行从 `DSH_CREW_PROVIDER`、`DSH_CREW_MODEL`、`DSH_CREW_EFFORT` 读取。

在角色行下方，**模型组合**选择器可以把这三条路由存成一个名字，之后一次选择就把三条一起写回。一套组合在结果上只有全成或全不成：页面先预检每个角色，若某个角色在写入中途拒绝，就把已经切换过的角色放回它找到它们时的状态。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包的实质是 [cordis.patch.yml](cordis.patch.yml)，由 `dsh.bundle.patch` 声明；模块本身不提供运行时 API。这一层插入三条 `subagent-*-route-settings` 行、一条 `subagent-route-presets` 行与四条 `@deepseek-ai/dsh-agent-preset` 声明，因此依赖 `dsh-web-app` 组合出的 host 面：Agent 预设注册表与 `subagentRouteSettings` 注册表。路由行放在这里而不是 `dsh-web-app`，所以没有选择编队 bundle 的 web 部署不提供任何编队路由命名空间，模型页也不显示编队路由块；命名空间没有对应的行提供服务时，它的委派行会拒绝加载，而不是悄悄路由到另一个角色。预设行是一个不含运行时行为的设置所有者：它提供选择器要写的那个命名空间，应用一套组合时通过各角色自己的行写入该角色的路由命名空间。

每个角色预设只由它自己的委派行挂载。指挥者的 `delegation` 组里有三条 `tool-subagent` 行；`maxDepth: 1` 把链限制在指挥者下一层。`tool-subagent` 自 2026-10-09 起不再接受 `persona` / `toolFilter` 配置，因此角色的人格与工具只来自它 `agentPreset` 指定的预设。

</details>

<a id="model-experience"></a>
## 模型体验

### 指挥者与角色的工具目录

#### 模型看到什么

指挥者看到三个委派工具——`worker`、`planner`、`reviewer`——以及控制行提供的 `send_message`、`list_agents`、`interrupt_agent`，再加上它的 `preset-tool-mask` 行所保留的宿主工具。每个角色子会话看到自己预设的工具集，同样经过收窄，以及一段写明边界的 persona：规划者写方案、审核者判方案，两者都不声称自己改代码。审核者的目录里根本没有文件编辑器和任务板写入工具，因此「除报告之外不写文件」是组合本身的性质，而不是要模型自觉遵守的请求。

#### Token 影响

指挥者的 persona 是本组合包里最大的固定开销，它承载了工具定义无法强制的协作规则。角色子会话各自加载自己的预设，不为其他角色的工具付费。

#### KV Cache 影响

角色子会话的工具目录由它的预设固定，因此同一个子会话内的重复请求保持稳定前缀。结算后重新派活会新建子会话，前缀随之重建。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **三个角色是并列的，不是门禁。** 指挥者可以跳过规划或审核，直接派 worker。方案 PASS 与交付 PASS 的绑定、方案变化后摘要失效、以及让门禁可执行的证据清单，属于另一份交付。
- **角色的「只读」边界由掩码行执行，而不是由行省略执行。** 每个预设的第一行是 `preset-tool-mask`，它在该预设作用域上调用 `tools.restrict()`，把继承来的全局工具收窄到声明保留的名字；规划者与审核者因此拿不到 `bash` 之外的写工具、MCP 文件编辑器与任务板写入工具。掩码是派生而非硬编码的，所以部署多挂一个插件时也会被一并收窄。`tool-subagent` 自 2026-10-09 起不再接受 `toolFilter`，掩码正是替代它的位置。
- **角色预设会出现在预设列表里。** 注册表没有隐藏标记，因此新建会话时 `crew-worker`、`crew-planner`、`crew-reviewer` 与 `crew` 并列出现；它们的名称与 `order` 标明只用于挂载。
