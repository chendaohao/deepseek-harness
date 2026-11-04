---
kind: upgrade-guide
description: "三条编队角色路由设置行从 dsh-web-app 移入 dsh-crew，因此 web profile 只在选择了该 bundle 时才显示编队路由块。"
---

# 编队路由设置移入编队 bundle

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-web-app` 不再插入 `subagent-worker-route-settings`、`subagent-planner-route-settings` 与 `subagent-reviewer-route-settings`；改由 `@deepseek-ai/dsh-crew` 插入。这些命名空间服务的是只有编队预设才会读取的设置，因此没有选择编队 bundle 的 web 部署此前提供了三项不可能生效的设置；模型页现在只为宿主确实服务的命名空间绘制编队路由块。

`subagent-route-settings-registry` 仍留在 `dsh-web-app`。自行挂载 `subagent-*-route-settings` 行的部署不受影响，已存路由（`provider`、`model`、`reasoningEffort`）、持久化的 `subagent/worker-route` 标记以及每个 `routeSettingsNamespace` 取值也都保持不变。

选择编队 bundle 的部署本身不受影响，除非该部署自己也插入了这三行之一：两行服务同一命名空间会让组合失败，报 `namespace "…" is already registered by another route-settings row`。

## 迁移

1. 若要继续使用编队路由块，在 `dsh.profile.bundles` 中把 `@deepseek-ai/dsh-crew` 排在 `@deepseek-ai/dsh-web-app` 之后并安装它（`dsh plugin add @deepseek-ai/dsh-crew`）。该 bundle 会带上三条行及其随附的基线路由。
2. 若 profile patch 自己插入了这三个命名空间的任一行，请删除这些条目：现在由该 bundle 拥有它们。`verify-cordis-config` 仍要求入口 id 等于其 `config.namespace`，而编队行已满足该要求。
3. 若要保留自己的第四条角色路由，可在任意位置挂载其 `subagent-*-route-settings` 行——它注入的注册表仍来自 `dsh-web-app`。其命名空间会出现在 `settings.describe()` 中，但模型页不会为它绘制行：页面唯一的行来源是 `packages/client/ui-settings-models/src/client/crew-routes.ts` 中的角色表。
4. 用 `dsh --profile <名称>` 确认：未选择编队 bundle 的 profile 在「设置 → 模型」下不会列出任何 `subagent-*-route-settings` 命名空间，选择了的会列出全部三个。
