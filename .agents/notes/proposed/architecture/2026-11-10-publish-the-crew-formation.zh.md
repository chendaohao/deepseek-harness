# 决策记录：按依赖顺序发布 Crew 编队

状态：提案中

[English](2026-11-10-publish-the-crew-formation.md) | 中文

## 问题

Crew 编队是这个 fork 里已经在跑的功能——四个预设、会话级的每角色模型路由、每轮硬预算、结构化的 `crew_git` 工具——但对任何从 npm 安装的人都不可见。`@deepseek-ai/dsh-crew` 不在 registry 上，而它下面那几层有 fork 独有之处，从 bundle 自己的 manifest 里看不出来。

关于"为什么发不出去"有三个看似合理的解释，逐一实测后全错；本记录存在的理由就是这个：每一种猜测都会产出一个启动即崩的发布计划。

| 假设 | 实测 |
|---|---|
| "`preset-tool-mask` 没发布，换成 `toolFilter` 就行" | `toolFilter` 被委派工具拒绝：`packages/subagent/tool-subagent/src/index.ts:188` 抛 `no longer supported`，已发布的 `0.2.2-rc.1` 里同样抛。而且 mask 已在 `origin/master` 上，它不是阻塞点。 |
| "竞品都用 `toolFilter` 做每角色收窄" | `dsh-swarm-orchestrator@0.6.34` 是通过编程式的 `subagents.start()` 调用传 `toolFilter`。它也会走到的 `composition.toolFilter` 路径只在冷恢复时生效（`manager.ts:1449`）；新建子会话传的是 `composition: { agentPreset: spec.agentPreset }`（`manager.ts:393`）。 |
| "三个 `dsh-tool-subagent/*` 子路径一下午就能提上游" | 能拷、能编译，但只能对着这个 fork 的 `dsh-settings`。`route-settings-registry.ts` 导入 `SettingsWriteGuardRegistration` 并调用 `settingsService.guard(...)`；上游两样都没有——`git show upstream/master:packages/settings/settings/src/index.ts` 里 `guard` 零命中。 |

## 提案

按这个顺序发布。每一层都必须先于它下面那项上线，因为先发布消费方会得到一个装上后启动即崩的包，比不发布更糟。

1. **`dsh-settings` 的命名空间写守卫。** `SettingsWriteGuard`、`SettingsWriteGuardRegistration`、`SettingsWriteRefusedError`、`SettingsForms.guard(ns, guard)`、descriptor 的 `writeRefusal` 字段，以及拒绝状态的重发布路径：占 `packages/settings/settings/src/index.ts` 新增 132 行中的 41 行。这是通用能力——任何"写入必须由其注册方否决"的命名空间都需要它——也是四层里唯一不含 fork 专有词汇的一层。无论 Crew 是否发布都值得落地，因为它缺席会逼着每个 fork 都去 fork `dsh-settings`。
2. **`dsh-tool-subagent` 的路由设置。** 五个 `worker-route-*` / `route-settings-registry` / `route-presets` 模块（375 行代码加 1,142 行测试），以及委派行上的 `routeSettingsNamespace` / `roleDescription` 字段。这五个是模块内部的——没有任何模块反过来 import `index.ts`——可以整体迁移，但 `index.ts` 保留读取命名空间的 17 处接线。
3. **`dsh-agent-preset-registry` 的 `userSelectable`。** 跨四个包共 88 行，是唯一能让角色预设既不出现在选择器里、又能被 `tool-subagent` 按 id 挂载的机制。没有它，发布出去的 Crew 会把 `crew-worker`、`crew-planner`、`crew-reviewer` 显示成根本用不了的会话类型。
4. **`dsh-preset-tool-mask`。** 175 行，只依赖 `dsh-scope` 和 `dsh-tools`，两者都已发布。四项里最便宜，且不阻塞任何其他项。
5. **`dsh-crew`。** 它的 manifest 里没有任何东西标记它是 fork 独有的；每个 `@deepseek-ai/dsh-*` 依赖都能解析到上游包。它没发布，只是因为它导入的三个子路径在已发布的 `dsh-tool-subagent` 里不存在。

### 开工前的验证

在这台机器的空目录里执行 `npm i @deepseek-ai/dsh-crew@0.2.2-rc.1` 返回 E404。开工时先重跑这一条：一旦 `dsh-crew` 已发布，第 1–4 步就不需要了。

## 考虑过的替代方案

**拿 fork 的 `master` 作为 `dsh-crew` 的依赖范围发布。** bundle 会对着这个 fork 已发布的包解析，而那些包同样不在 registry 上；消费者得先把这个 fork 加为 registry 才装得上。

**把五个路由模块内联进 `dsh-crew`。** 这样能去掉链路里的 `dsh-tool-subagent` 子路径导出，但 `route-settings-registry.ts` 仍然需要 `settings.guard()`，所以第 1 步还在；而且 crew bundle 从此要维护委派工具也在读的代码。

**去掉 `userSelectable`，只在预设模板里列出 commander。** 更少的上游改动，但直接指名角色预设的会话会在更晚的时候失败，而不是在创建时；而且一个部署挂上 bundle 之后，名册照样会提供那些角色。

**不发布，bundle 保持本地路径。** 也就是现状。它零成本，并且服务这个 fork 存在的那一个部署；本记录记的是"改变现状的代价"，不是一个发布要求。

## 验收标准

- 在空目录里干净执行 `npm i @deepseek-ai/dsh-crew@<version>` 能装上；`dsh` 能启动一个选择了该 bundle 的 profile，commander 预设可用，三个角色预设不出现在选择器里。
- 已发布的 `dsh-tool-subagent` 导出 `./worker-route-settings`、`./route-settings-registry`、`./route-presets`，且其 `Config` 接受 `routeSettingsNamespace`。
- `packages/settings/settings` 发布 `guard()`；一个注册了守卫并返回原因的命名空间，写入会以 `SettingsWriteRefusedError` 拒绝。
- 任何已发布包的依赖图里都不出现 fork 独有的包名。

## 风险

- **链条五层深。** 其中任何一环回归都会推迟 Crew，而第 1–3 步每一层都大到需要独立评审。
- **第 2 步发布的是这个 fork 发明的 API。** 委派行上的 `routeSettingsNamespace` 只有一个部署验证过；上游评审可能倾向别的形状，而发布之后再改形状是一次破坏性变更。
- **第 1 步在第 2 步落地前没有上游消费者。** 单独落地会新增一个没人调用的注册点，这与"抽象必须有当前拥有者"的规则冲突。
- **Crew 只有一个用户。** 这四项上游改动是否值回成本，是产品决定，本记录不做。
