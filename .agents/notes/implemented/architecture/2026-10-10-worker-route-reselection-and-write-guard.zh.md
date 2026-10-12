# Agent Note: 工人路由的子会话每次请求重新解析 LLM 路由

Status: implemented

[English](2026-10-10-worker-route-reselection-and-write-guard.md) | 中文

## Problem

启用 `workerRouteSettings: true` 的 `tool-subagent` 在每次委派时读一次宿主 `subagent-worker-route` 设置，并把结果烘焙进子会话的 `AgentOptions`。因此把提供方额度耗尽的工人到死都停在同一条路由上：操作者可以改设置，但唯一能生效的办法是另派一个工人，而那会丢掉失败工人手里的现场——它读过哪些文件、得出过什么结论——偏偏此时现场最值钱。

该设置当时也没有写入闸门。表单写入任何时候都能落到任何命名空间，因此一次编辑可能落在工人的提示组装与请求路由之间。

## Decision

有效路由来自该设置的委派子会话会记录一个持久化的纯日志事件 `subagent/worker-route`，写明它跟随的设置命名空间。`tool-subagent` 会为日志中带该标记的每个 Agent 安装 `installModelSelection`：新激活时安装一次，之后某次激活从日志重建子会话时，由 `agent/created` 派发再安装一次。安装的选择引用通过 getter 读取 `SubagentWorkerRouteConfig.current()`，因此提示组装与请求路由每次请求都重读设置，子会话的对话里也会落下常规的模型切换告知。宿主侧的 `subagentWorkerRoute` 投影折算该标记；它从不进入模型可见内容。

只有设置本身给出的路由会跟随设置。调用中自己指名路由或推理档的子会话保持所指定的值，不留标记；未开启该选项的工具行也不会留标记。

同一个插件持有该命名空间的写入守卫。`SettingsForms.guard(ns, guard)` 是逐命名空间的注册点；写入入口在解析取值之前咨询每个守卫，并在有守卫拒绝时抛出带全部原因的 `SettingsWriteRefusedError`。本版本中委派工具在自己的 fiber 上注册唯一的守卫：当日志带该标记的 Agent 持有一个运行中的轮次时，写入 `subagent-worker-route-settings` 被拒绝。子会话每次请求都重读该设置，因此改写若落在请求组装期间，就会改变已在发往提供方途中的请求的路由；谓词无法区分请求组装与一轮中各请求之间的间隙，所以整个运行轮次都持有写入，而已结算工人的空闲正是恢复流程需要的窗口。该设置从未路由过的工人保持创建时的路由，从不持有写入。`SettingsForms.describe()` 把守卫当前的答复作为描述符的 `writeRefusal` 发布，模型设置页依据这个已发布的拒绝原因禁用三个选择器；拒绝的权威在宿主。由于守卫是拉取式谓词，注册句柄的 `refresh()` 会把翻转后的答复以 `settings/document-updated` 重新发布，而工具会在带标记 Agent 状态变化时调用它——开着的模型设置页能看着锁解除，不必等浏览器刷新。即使多个开启该选项的工具行同时宣告同一个恢复的子会话，一个 Agent 也只安装一次选择引用；模块级的、以 Agent 为键的集合为各行的 `agent/created` 监听器去重。

## Alternatives considered

**设置变更时另派一个工人。** 新委派不需要任何新的持久状态就能用上新路由，也正是操作者今天的做法。代价是丢掉失败工人的现场，而恢复流程存在的理由恰恰是这个现场。

**不为子会话打标记，所有 subagent 子会话都按设置解析路由。** 可以让每个 `origin: 'subagent'` 的 Agent 都走设置。但一个父会话可以挂多个配置不同的委派工具行，日志里没有别的东西把子会话归属到某个行；由普通 `subagent` 行创建、未打标记的子会话会失去它自己工具选定的路由。

**只要存在任何 subagent 就锁住设置。** 已结算或失败的工人仍可续聊、仍在列表里，该锁会活得比它所守护的状态更久，反而挡住它本要保护的恢复流程。「在使用」指的是运行中。

**只要有委派工人在运行就锁住设置。** 跟随该设置的子会话在下一次请求会重读它，因此已结算工人的路由并不在使用中，为它持锁反而挡住了工人正在等待的那次编辑。只有已经在途的请求才有风险，而且只对确实被该设置路由过的子会话成立。

**只在客户端拦住写入。** 宿主持有 profile patch，Remote API 不经过模型设置页也能到达，因此客户端锁只是建议。禁用控件保留为已发布拒绝原因的镜像。

**在客户端从 Session 列表自行推断该锁。** 客户端能看到哪些 Session 报告 `running`，早期修订就是从该列表禁用选择器的。它回答的并不是写入入口所执行的那个问题——它看不到标记，也滞后于宿主自身的状态——因此页面会为改写根本不会触碰的工人禁用控件，也可能对会被触碰的那个保持可用。

## Consequences

设置改动会作用于每个跟随该设置的工人，包括宿主进程重启后被恢复的那个；证据就在子会话自己的日志里。代价是当前 Session 格式多一个事件类型：早于该事件的读取方会拒绝带它的日志，而不是去路由一个它无法重建的子会话，因此工人会话尚在进行时不要把部署回退到旧版本。持久化规则把「新增普通事件类型」归为同版本变更。

写入守卫没有给 `SettingsForms` 增加新的耦合：它只运行注册方自己的谓词，从不自己检查 Agent；唯一检查 Agent 的谓词由委派工具持有。未组合 Agent 注册表的部署会让该谓词读到空列表，因而恒放行，因为它不可能有委派工人。

守卫挂在委派工具自己的 fiber 上，而不是设置拥有者上，因为可续聊的子会话会活得比委派它的那一行更久：创建工人的那一行才是工人所跟随配置的来源，而冷恢复会从标记、在彼时挂载的那一行之下重新安装。

## Testing

`packages/subagent/tool-subagent/tests/worker-route-reselection.spec.ts` 驱动真实的进程内提供方栈：两轮之间改设置、在同一存储上重启、以及显式按次指定路由而不留标记。`worker-route-state.spec.ts` 覆盖标记与其投影。`worker-route-guard.spec.ts` 在真实 Agent 的运行轮次中驱动该谓词：跟随的工人持锁直到结算，该设置未路由过的工人从不持锁，且工人结算时会请求设置服务重新发布。reselection spec 还覆盖两个开启该选项的工具行恢复同一个子会话时只有一条模型切换告知。`packages/settings/settings/tests/configuration.spec.ts` 覆盖守卫注册点以及 `describe()` 发布的 `writeRefusal`；`packages/api/settings-controller/tests/settings-controller.host.spec.ts` 覆盖该字段到达 wire view。页面的禁用状态与拒绝提示由 `components.client.spec.tsx` 与 `worker-route.client.spec.tsx` 覆盖。
