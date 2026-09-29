---
description: "循环卫生守卫：当一个 turn 把全部输出预算烧在私有推理上时，给它一次有界的恢复机会。面向选用、配置或调试该插件的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-max-tokens-recovery

[English](README.md) | 中文

## 概述

提供方可能在某个 step 只流出了私有推理的情况下，把它停在输出 token 上限。该 turn 随后以既无可见文本、也无工具调用结束，于是 agent 不再推进，而它的过程记录看上去仍然健康——这个失败对任何读对话的人都不可见。本包识别出这样的 step，并为下一轮排入一条简短的恢复指令，让模型交付最小的具体改动，而不是重新规划。每一段连续触顶只恢复一次；`dsh` base bundle 以 `maxRecoveries: 1` 启用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 长时间无人值守、任务大到足以让模型思考超出输出上限时，挂载本插件。无需接线：`dsh` base bundle 已经运行它，唯一的默认值适用于大多数会话。

### 何时选用

当「agent 无声停下」代价高昂时选用它——后台工人、无人值守的目标轮次——此时多花一次请求确认模型是否还能交付，比几天后才发现什么都没写要便宜。当每一次触顶本身都有意义、自动重试只会重复劳动时，则不要用。

### 设置恢复预算

```yaml
- name: '@deepseek-ai/dsh-max-tokens-recovery'
  config:
    maxRecoveries: 1   # recovery prompts per run of consecutive ceiling hits
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxRecoveries` | `1` | 每段连续触顶允许的恢复提示数；`0` 关闭该守卫 |

只要有 step 提交了可见文本或发起了工具调用，这一段就结束；因此真正恢复过来的 agent，下次再触顶时仍然合格。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-max-tokens-recovery)记录了所有可接受取值。

### 你会得到什么

在默认配置下，把全部预算花在推理上的 agent 会收到一条简短提示，要求给出最小的具体下一步改动。若它下一轮产出了工作，这一段就此结束；若它再次触顶，守卫保持沉默，该 turn 按原本的方式结束——最坏情况是多一次请求，而不是无人值守的重试循环。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本节说明守卫如何识别该失败并排入恢复；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计取向

- **只认输出上限。** 一个 turn 也可能因为父级把它停掉、或策略拒绝了它而什么都没产出。这些不是输出预算失败；把它们也归因于触顶，会让下一次尝试瞄准一个从未生效的约束。
- **两半都必须满足。** 请求了工具调用的 step 就是进展，即使它没有输出文本；输出了文本的 step 就是干了活，即使随后触顶。两者都不是本守卫要处理的那种无声停摆。
- **恢复一次，然后收手。** 守卫给 agent 一次交付机会，然后让开。不断升级的重试预算会把一次慢交互变成无人值守的循环。

### 检测

守卫监听 `session/event`，用 `WeakMap<Agent, {recoveries}>` 保存这段连续触顶的计数。对每个结算的 `assistant/message` 或 `assistant/attempt`，它借助共享的 reader（而不是自行推导）就该 step 自己的紧凑流提三个问题：是否带有可见文本（`assistantStreamHasVisibleText`）？是否带有工具调用？它最后的 `finish` chunk 是否写着 `max-tokens`？只有「否、否、是」的 step 才是该失败。

由于只要有 step 提交了工作计数器就归零，预算是按「一段连续触顶」而不是按会话计算的——恢复过来的 agent 之后仍然合格。

### 恢复投递

恢复是一条普通的 `user/message`，来源为 `{kind: 'max-tokens-recovery'}`，通过 `Agent.followup` 排入，因此它会开启自己的 turn：触顶的 step 结束了它所在的 turn，无法在该 turn 内追加。监听器用 `queueMicrotask` 延后这次排入，因为 `session/event` 是在发布它的那次 append 内部投递的，而 append 会拒绝任何重入的 append——包括队列变更会执行的那次。

子 agent 的触顶是它父级的问题：守卫只解析 `ctx.agents.get(session.id)`，对任何 live agent 并非同一个的会话一律忽略，因此恢复不会为被委派的子级或 fork 触发。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、触顶判据、延后的恢复 |
| — | 不发布运行时不变式伴随包；计数器是一个监听器私有的状态，不暴露可供独立伴随包观察的包自有事件。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Agent 主循环](../../core/agent-loop/README.zh.md)——turn 与 step 边界，以及触顶在何处结束一个 turn。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-max-tokens-recovery)——所有可接受配置字段及其来源声明。
- [guard 分组地图](../README.zh.md)——同组守卫包与循环卫生家族。
- [子 agent 结算通知](../../subagent/subagent/README.zh.md#settlement-notice)——父级如何从被委派子级处得知同一失败。

-----

<a id="model-experience"></a>
## 模型体验

### 触顶恢复提示

#### 模型看到什么

一个用户角色的 turn，排在一个只流出推理并停在输出上限的 turn 之后。不会向任何 step 追加内容，工具 schema 也不变。

##### 恢复提示

```markdown
Your previous turn hit the output token ceiling before emitting any visible text or tool call, so it produced nothing. Do not restate the plan or re-derive the design: make the single smallest concrete change or tool call that moves the work forward, and keep the explanation to one short sentence.
```

#### Token 影响

触顶之前零 token。每次合格触顶消耗一条保留提示加一次模型请求，且每段连续触顶由 `maxRecoveries` 限定。

#### KV Cache 影响

仅追加：提示位于可复用请求前缀之后，不会使已有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该守卫何时不合适。它们是当前包约束，不是任务积压。

- **只识别输出上限**——因其它原因停摆的 turn（包括提供方给出不同截断信号的场景）不在范围内。
- **恢复是通用的**——守卫只能点名约束，无法描述任务；更具体的指令需要了解该项工作的消费方。
- **恢复过的 agent 仍可能失败**——该提示提高了下一步是具体动作的概率，并不保证如此。
- **计数器仅限进程内**——从持久化恢复的会话会重新开始计数，因此跨越恢复的触顶会得到第二次恢复机会。
- **以文本作为进展证据**——只流出工具调用的 step 一律算作有工作，无论那次调用是否成功。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
