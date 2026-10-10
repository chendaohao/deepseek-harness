---
description: "编译类命令串行化 guard：同一时刻只放行一条 install、build、typecheck 或 coverage 命令，并以可重试的文案拒绝并发命令，供在同一检出目录里协调多个 agent 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compile-serialization

[English](README.md) | 中文

## 概述

当多个 agent 共用同一个检出目录、各自的 install、build、typecheck 与 coverage 命令会互相覆盖 `node_modules`、`lib/`、`dist/` 和 `.tsbuildinfo` 产物时，使用本包。它同一时刻只放行一条编译类命令，并以写明「正在跑什么命令、由哪个会话启动」的文案拒绝并发命令，模型据此可以等待后重试。由于它是拒绝而不是排队，`dsh` 基础组合包默认关闭；在多个 worker 共用工作树的部署里再开启。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

常用路径只有一行：把插件加入组合。基础组合包以关闭状态随包提供，因此基于 base 的 profile 用一条覆盖行开启它。

### 何时选择

当同一个检出目录里不止一个 agent 执行 shell 命令时选择它——例如把工作委派给子会话的 Crew 式部署，或在同一工作区上并行跑多个子会话的 workflow。当 agent 之间从不共享构建产物时不要用它，因为 guard 会把一次无害的并发调用变成拒绝；当某条编译命令可能合理地超过配置的租约时也不要用它，因为下一条编译命令会抢占它。

### 配置

开启基础组合包中默认关闭的那一行：

```yaml
- id: compile-serialization
  disabled: false
```

用配置调整可识别的命令与两个边界值：

```yaml
- id: compile-serialization
  disabled: false
  config:
    commandPatterns:
      - '\b(?:pnpm|npm)\s+(?:install|ci)\b'
      - '\bmake\s+build\b'
    toolNames: [bash]
    commandPreviewChars: 160
    leaseTimeoutMs: 7200000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `commandPatterns` | install/build/typecheck/coverage、`tsc --build`、带 `--coverage` 的 `vitest`/`jest`，以及 `vite`/`tsdown`/`webpack`/`rollup`/`esbuild build` | 与命令文本匹配的正则源；任一命中即为编译类 |
| `toolNames` | `[bash, pwsh]` | 会检查其 `command` 参数的工具名 |
| `commandPreviewChars` | `120` | 拒绝文案中引用的正在运行命令的最大字符数 |
| `leaseTimeoutMs` | `3600000` | 超过该时长仍处于登记状态的命令视为泄漏，下一条编译命令可以接管 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compile-serialization)是全部可接受字段的完整来源。

### 得到什么

一条编译类命令在跑；在它未结束时发起的第二条会被拒绝，文案为 `Error: another compile-class command is still running: <tool> in session <id> started <n>s ago: "<command>". …retry this command after that one finishes.`。该拒绝是普通错误结果，因此模型可以选择等待后重试这次调用，而不是断定部署坏了。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明一个同步 guard 如何在进程内把所有 agent 的命令串行化，并指出实现它的代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计理念

该 guard 建立在四项承诺上：

- **只拒绝，不排队。** `ctx.tools.guard()` 是同步的，只返回拒绝理由或 `undefined`，因此 guard 无法等待正在运行的命令。它以可重试的文案拒绝后来的调用，把等待与否的决定留给模型。
- **全进程一个槽位。** 一个进程可能同时持有本包的两份副本——打包的 `lib/` 与 `src/`——若登记表按模块存放，两份副本会各自放行一条命令。因此在飞登记存放在以 `Symbol.for('dsh.guard.compile-serialization.in-flight')` 为键的表中，与 `dsh-tools` 为其调度器符号使用的跨副本身份机制一致。
- **编译类由配置决定，而非硬编码。** 模式表与工具列表都是经校验的 `Config` 字段，部署可以自行指定构建命令，而不必继承某种既定看法。
- **登记不会泄漏。** 每条被放行的执行都会到达 `tools/result`——包括被拒绝、工具报错和取消——该事件据此释放精确匹配的已放行令牌。另外两条释放路径覆盖了到不了结果的情况：调用方信号中止会让其登记立刻可回收，插件销毁会清掉本实例拥有的登记。

### 命令如何被串行化

一个单调 guard 在工具名属于 `toolNames` 且任一配置模式命中时读取调用的 `command` 参数。若当前没有在飞登记，它记录执行令牌、工具名、agent id、调用方信号与开始时间，并弃权。若已有在飞登记，它返回写明正在跑什么的拒绝理由。泄漏阀门把「调用方信号已中止」或「持有时间超过 `leaseTimeoutMs`」的登记视为可回收。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`/`inject`/`Config`/`apply`、全进程表、guard，以及三条释放路径 |
| — | 不发布运行时 invariant 伴随文件；本包只拥有一个全进程单元，其唯一自有关系（登记只由其自身执行清除）在 `src/index.ts` 中实现并测试，而非独立观测。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，阅读以下页面。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— guard 执行管线、`ToolGuard` 类型，以及本插件用于释放的 `tools/result` 事件。
- [防御性模式](../../../docs/defensive-patterns.zh.md) —— 各释放路径遵循的生命周期与并发规则。
- [guard 组映射](../README.zh.md) —— 同级 guard 包与循环卫生家族。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compile-serialization) —— 本插件的全部可接受字段。

-----

<a id="model-experience"></a>
## 模型体验

### 并发编译命令拒绝

#### 模型看到什么

当另一条编译类命令在飞时，编译类调用会得到一个错误结果，其中写明正在运行的工具、其会话、已运行时长，以及被截断的命令副本。其余调用（包括非编译类的 shell 命令）保持不变；prompt 与工具 schema 均无变化。拒绝文案为 `another compile-class command is still running: <tool> in session <id> started <n>s ago: "<command>"`。

#### Token 影响

被放行的调用零 token。一次拒绝增加一个数十 token 的保留错误结果，并避免一条会破坏共享构建产物的编译命令。

#### KV Cache 影响

仅追加：拒绝内容位于可复用请求前缀之后，不会使既有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了本 guard 不适合的场景。它们是本包当前的约束，不是待办清单。

- **只拒绝，不排队** —— guard 无法等待正在运行的命令，因此被拒绝的调用立即失败，必须由模型重试。需要自动排队的部署需要的是 `tools/execute` 上的异步包装器，而这正是本 guard 有意不做的事。
- **模式匹配，而非命令解析** —— 没有任何配置模式命中的编译类命令（自定义脚本名、`make` 目标、shell 别名）不会被串行化。请补充模式，或接受这一缺口。
- **每进程一个槽位，而非每检出目录一个** —— 该表是全进程的，因此同一进程内构建两个无关检出目录的 agent 之间也会串行化。这是有意为之（另一种做法需要按工作区标识），但当这些部署彼此独立时它会损失吞吐。
- **租约阀门可能抢占慢命令** —— 运行时间超过 `leaseTimeoutMs` 的合法编译命令会被视为泄漏并被接管槽位。当某条命令可能超过该值时请调高该字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：其中是尚未决定的问题与方向。它明确不具备权威性——已发布的行为、限制与已采纳的理由以本文档以上各节、包代码与所链接的 Agent Note 为准。

基础组合包以 `disabled: true` 提供该行。未来可以改为依据「该组合能否委派给子会话」推导是否启用——正是这一条件让本 guard 有价值——而不是让每个部署自行选择加入。

</details>