---
description: "workspace 扩展 bundle：把会话置顶与远程访问的 fork 本地行作为 web profile 的最后一个 bundle 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-workspace-ext

[English](README.md) | 中文

## 概述

`dsh-workspace-ext` 是 fork 自己的 bundle 层：它把会话置顶服务和远程访问栈（隧道、配对门、移动 `/m` 表层）插入 web profile，而不触碰随发行版交付的 `dsh-base` 或 `dsh-web-app` patch。web profile 把它列在 `dsh-web-app` 之后，因此它的行组合在完整的上游树之上，并且在 `--remote` 旗标启用之前保持惰性。

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

这些行自动生效：随发行版交付的 `web` profile 模板把本 bundle 列在 `dsh-web-app` 之后，因此每次 `dsh web` 启动都会组合它。会话置顶随 profile 一起激活；remote 行在你传入 `--remote`（或传入 `--remote-reset` 以同时轮换配对密钥并吊销全部已配对设备）之前保持惰性。

### 你会得到什么

开箱即用，web profile 获得持久的 `session/pin` 事件与置顶优先的会话排序，以及在 `--remote` 之后的公网 HTTPS 隧道、配对门反向代理和 `/m` 上的独立移动表层。每行的行为由各自的包负责：`@deepseek-ai/dsh-session-pin`、`@deepseek-ai/dsh-remote-tunnel`、`@deepseek-ai/dsh-remote-access` 与 `@deepseek-ai/dsh-client-ui-remote`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本 bundle 是一份静态 patch 文档：在前面各层组合出的树上应用一个 `insert` 列表。它自己不挂载服务、不发事件、不持有可变状态；每个被插入行的行为与不变量由该行的包负责。

### 组合机制

本 bundle 是 web profile 的最后一层，位于 `dsh-web-app` 之后，因此它的行能看到全部上游行且不覆盖任何行——patch 不含按 id 定向的条目。remote 行读取 `webStartup` 旗标服务的方式与 `dsh-web-app` 的行完全一致：`inject` 把每行推迟到服务存在之后，而 `dsh --profile web --help` 不提供 `webStartup`，因此没有任何远程表层激活。需要这些行的自定义 profile 显式列出本 bundle；keyless web e2e scaffold 叠加同一份 patch，使测试与产品组合无法漂移。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 本 bundle 的实质：四个 fork 本地行，逐行理由以行内注释给出 |
| [`src/index.ts`](src/index.ts) | 包入口；不含运行时 API |
| — | 不发布运行时不变量伴生文件；本包是静态 patch 列表载体（一份由其他包拥有各行的 loader 行 YAML 文档），不挂载服务、不发事件、不拥有需要检查的可变关系。每个被插入行的不变量由该行自己的包承载。 |
| [`tests/workspace-ext.spec.ts`](tests/workspace-ext.spec.ts) | 清单声明与行门控检查 |

### 不变量归属

不发布不变量伴生文件，因为本包是静态 patch 列表载体：每个被插入行的不变量由该行的包负责，本 bundle 不拥有需要检查的可变关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

想深入了解 profile、这些行构建的表层或确切组合时，阅读以下页面。

- [app-boot profile 章节](../../boot/app-boot/README.zh.md) — profile 如何被解析、分层与定制。
- [Bundle 包地图](../README.zh.md) — 构建在这个核心之上的表层。
- [生成的组合图](../../../apps/cli/composition.md) — 每个随发行版 profile 使用的确切插件集合。
- [Profile 插件 bundle 备注](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md) — profile 与 bundle 的组合设计。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过每个被插入行的包，由它拥有该行的模型可见行为。

#### KV Cache 效应

本 bundle 自身不增加任何请求前缀；每个被插入行的包拥有各自的缓存效应。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明这些行何时需要额外注意、覆盖应落在哪里。它们是当前的包约束，不是泛泛的对比或任务清单。

- **仅限 web profile 的行** — `headless`、`sdk` 与 `acp` 模板不叠加本 bundle，因此这些表层既没有置顶也没有远程栈；需要它们的自定义 profile 应显式列出本 bundle。
- **远程门控跟随 web 旗标** — remote 行从 `dsh-web-app` 的 startup 表层读取 `ctx.webStartup.remote`，因此在未挂载该表层 startup 插件的 profile 上它们无法激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
