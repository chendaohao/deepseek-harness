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
- [开发备注](#dev-note)

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
| `crew-worker` | 否（`userSelectable: false`） | 执行者，持有完整的工作工具集 |
| `crew-planner` | 否（`userSelectable: false`） | 写方案，不改代码 |
| `crew-reviewer` | 否（`userSelectable: false`） | 给出 PASS 或 FAIL 并附证据，什么都不改 |

新建会话的预设选择器与预设页只显示 `crew`。三条角色声明供委派行挂载；在 `session.create` 里点名它们会被拒绝，而不是启动一个上面没有指挥者的角色子会话。

每条委派行读取自己的路由命名空间，因此三个角色可以跑在三个不同模型上；记录过组合的会话优先于该命名空间，没记录过的会话继续读它。这些命名空间由本 bundle 提供，所以只有选择了本 bundle 的 profile 才在「设置 > 模型」页显示编队路由块。在其中按工人、规划、审核三行分别设置；改动在该角色的下一次请求生效，续作与冷恢复一样生效。没有存过路由时，该行回退到它的 `agentOptions` 基线，工人行从 `DSH_CREW_PROVIDER`、`DSH_CREW_MODEL`、`DSH_CREW_EFFORT` 读取。

「设置 > 模型」页编辑的是**模型组合库**，不是正在运行的会话路由：先选一套组合，再选三个角色之一，然后编辑该角色的提供方、模型与思考等级。保存只写组合库，所以某个角色正在运行也照常能改。

新建 crew 会话时在预设旁选一套组合，这个选择记在该会话自己身上。会话还没开始首轮之前，再选一套组合会替换已记录的那套；首轮一旦开始，会话就保持已记录的路由。之后修改组合库，或另一个会话选了别的组合，都不会改变这个会话已记录的路由。委派失败时按角色单独修复：会话记录这次替换，并不再匹配它原本的组合。

会话头部的「换路」按钮打开实时模型目录，通过 `crewFormation/replaceRole` 只替换选中的角色。选择组合或换路时会检查确切模型与适配器当前鉴权状态，不发送推理请求；拒绝时保留已记录的路由。换路本身不会重试失败工作；完成后让指挥续作原子代理，它的新 turn 会读取替换后的路由。

每个角色 turn 都受 `crew-formation.budget` 的步数、时长、总 token 与重复失败限制。默认值依次为 300 步、60 分钟、5000 万 token（含缓存读写）、同一工具失败连续 6 次。「设置 > 子智能体」页可以编辑这四项。达到上限时追加 `crew/run-budget-exceeded`，并在继续工作前阻断或取消该 turn。正在运行的 turn 保留启动时的限额；保存的修改与手动续作从下一个 turn 开始使用新预算。

指挥者按混合判据触发 `planner`。用户点名要规划或设计，就派 planner；用户明确排除，就不派；两者都没有时，只有当一个尚未确定的设计选择回退成本很高——接口或模块归属存在竞争、架构方案实质不同、或需求之间冲突——才派 planner。派 planner 之前必须先给出事实包：带证据的已核实事实、假设、未知项、用户决定、目标指标与非目标。planner 出方案后交给 `reviewer`，没有方案 PASS 就不为这条已规划的路径派 worker。`planner` 工具描述只说明用途，触发规则只写在指挥者 persona 一处。

工人复用按验收目标决定，不看目录，也不看剩余预算。同一个未完成的验收目标内，指挥者用 `send_message` 续用原工人做增量修复、补测试用例、重复验证和 reviewer 要求的返工。新目标或新阶段、同目录下的独立任务、旧上下文大部分无关、或反复漂移，都改派新工人。没有收尾消息的失败留在原工人身上：先查它的 interim report，完整就接受，只有在同一失败出现两次或出现 clear drift 之后才换人；新验收目标或新阶段仍然换新工人。文件与报告本来就在共享工作区，复用保留的只是工作上下文。

自动压缩可以让工人在同一个未完成目标内继续，前提是它的上下文仍然相关；自动压缩绝不能用来为新目标复用工人——交接报告并换新工人。运行预算按 turn 生效，从不构成复用理由，因此因预算停止或 quota/auth 终止失败的工人不会被自动续作：先由用户选择缩小任务、显式调整预算或更换路由。替换仍在运行的工人前，必须先停止或结算它，并检查它的产物与后台任务。

会话自己的路由由本 bundle 挂载的 formation 服务（`dsh-crew/formation`）记录，委派行在读取自己已存默认值之前先经 `subagentRouteSettings` 读它。这也是组合不需要为每个会话再开一个设置命名空间的原因：会话日志就是存储，冷恢复重放同一套路由，不必回查组合库。

指挥者没有通用 shell，也没有文件写入或编辑工具。所有实施动作都派给 `worker`，包括单文件补丁和单独一条测试命令。`crew_git` 支持只读操作 `status`、`diff`、`log`、`show`、`ls-files`、`rev-parse`；写操作 `checkout`、`reset`、`restore`、`stash`、`clean`、`commit`、`push`、`rebase`、`merge`、`switch` 默认需要用户批准。在 `crew-commander-git` 行设置 `requireWriteApproval: false`，或把它的 `DSH_CREW_GIT_REQUIRE_WRITE_APPROVAL` 环境输入设为 `false`，可授权写入而不再逐次审批；两种设置都不会绕过 Session 沙箱。参数是逐条校验选项白名单的字面 argv 值。每次调用都应用 Session 沙箱策略，禁用仓库钩子和文件系统监视器，拒绝打开编辑器，并且绝不调用 shell 或外部远程助手。

只读操作另外拒绝仓库自身配置能够执行的任何程序。读取开始前，工具先列出在该仓库生效的 Git 配置键，通过 Git 的环境键值槽位，把其中的程序键——内容过滤器、合并驱动器、diff 助手、签名程序、编辑器、传输命令、凭据助手——仅对本次调用覆盖为空串。分离的键值槽位能保留含 `=` 的子节名。读取会禁用 `log.showSignature`，把仓库的 `format.pretty` 替换为 `medium`，拒绝 `--format=` 中的 `%G…` 签名占位符，并清除继承的 Git 追踪输出目标。如果完整键列表超过 `maxOutputBytes`，读取会报 `CREW_GIT_CONFIG_UNREADABLE`，而不是使用不完整的覆盖继续执行。配置、index 及其时间戳都不被写入；读取显示的是被过滤文件的存储字节（Git LFS 指针），而非还原后的内容。写操作保留仓库的过滤器与合并驱动器，因为提交和检出依赖它们；默认启用逐次审批时，用户对写操作的批准就是把这一后果摆在面前。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包通过 [cordis.patch.yml](cordis.patch.yml) 组合各角色，该文件由 `dsh.bundle.patch` 声明；Host 模块同时导出只供指挥者使用的 `crew_git` 插件。这一层插入三条 `subagent-*-route-settings` 行、一条 `subagent-route-presets` 行与四条 `@deepseek-ai/dsh-agent-preset` 声明，因此依赖 `dsh-web-app` 组合出的 host 面：Agent 预设注册表与 `subagentRouteSettings` 注册表。路由行放在这里而不是 `dsh-web-app`，所以没有选择编队 bundle 的 web 部署不提供任何编队路由命名空间，模型页也不显示编队路由块；命名空间没有对应的行提供服务时，它的委派行会拒绝加载，而不是悄悄路由到另一个角色。预设行提供选择器编辑的组合库。创建会话时把选中的组合传给 `crewFormation/selectRoutes`，由它把完整路由记录在该会话上；各角色的解析器通过 `subagentRouteSettings` 读取这条记录，只有没有记录的会话才回退到角色路由设置命名空间。

每个角色预设只由它自己的委派行挂载。指挥者的 `delegation` 组里有三条 `tool-subagent` 行；`maxDepth: 1` 把链限制在指挥者下一层。`tool-subagent` 自 2026-10-09 起不再接受 `persona` / `toolFilter` 配置，因此角色的人格与工具只来自它 `agentPreset` 指定的预设。

</details>

<a id="model-experience"></a>
## 模型体验

### 指挥者与角色的工具目录

#### 模型看到什么

指挥者看到三个带角色专用说明的委派工具——`worker`、`planner`、`reviewer`——以及控制行提供的 `send_message`、`list_agents`、`interrupt_agent`。它保留读取、搜索与 `crew_git`，但没有通用 shell 或文件写入工具。每个角色子会话看到自己预设的工具集，同样经过 `preset-tool-mask` 收窄，以及一段写明边界的 persona：规划者写方案、审核者判方案，两者都不声称自己改代码。审核者的目录里根本没有文件编辑器和任务板写入工具，因此「除报告之外不写文件」是组合本身的性质，而不是要模型自觉遵守的请求。planner 的工具描述只说明该角色产出什么；值不值得花一轮 planner 由指挥者 persona 的一条条款决定。

#### Token 影响

指挥者的 persona 是本组合包里最大的固定开销，它承载了工具定义无法强制的协作规则。角色子会话各自加载自己的预设，不为其他角色的工具付费。

#### KV Cache 影响

角色子会话的工具目录由它的预设固定，因此同一个子会话内的重复请求保持稳定前缀。结算后重新派活会新建子会话，前缀随之重建。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **这些规则是提示词约束，不是运行时强制。** 混合 planner 触发、事实包、按验收目标复用、压缩选择以及方案 PASS 与交付 PASS 的措辞都写在指挥者 persona 和工具描述里。指挥者仍然可以跳过规划轮次、跨目标复用工人、或在没有交付 PASS 时声称完成。两者的运行时拒绝都属于第二批交付。
- **三个角色是并列的，不是门禁。** 指挥者可以跳过规划或审核，直接派 worker。方案 PASS 与交付 PASS 的绑定、方案变化后摘要失效、以及让门禁可执行的证据清单，属于另一份交付。
- **角色边界使用不同机制。** 指挥者的预设没有通用 shell 与文件写入行，因此不能直接实施。每个角色预设还以 `preset-tool-mask` 开头，在该预设作用域上调用 `tools.restrict()`，把继承来的全局工具收窄到声明保留的名字。掩码是派生而非硬编码的，所以部署多挂一个插件时也会被一并收窄。规划者与审核者仍保留 shell 行以支持其读取和报告流程；它们的 persona 仍禁止实施与长命令。
- **角色预设声明为不可选，而不是被隐藏。** 每个角色带 `userSelectable: false`，所以新建会话的预设选择器与预设页只提供 `crew`；`session.create` 点名某个角色会被以 `agent-preset/invalid` 拒绝。这个标记是名册上的事实，不是注册表策略：内部挂载按 id 点名预设，从不读它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文——点击展开</summary>

无。

</details>
