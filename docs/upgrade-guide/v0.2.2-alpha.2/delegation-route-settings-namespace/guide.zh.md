# 委派路由设置改为命名空间声明

`@deepseek-ai/dsh-tool-subagent` 不再接受 `workerRouteSettings: true` 布尔值。委派工具行现在用 `routeSettingsNamespace` 指明自己跟随的设置命名空间，该命名空间由组合中的 `subagent-*-route-settings` 行提供，且其 Loader entry id 必须等于 `config.namespace`。三个角色可以并列组合——`subagent-worker-route-settings`、`subagent-planner-route-settings` 与 `subagent-reviewer-route-settings`——各自把 owner 发布进共享注册表，而不是每行抢占同一个服务名。

## 1. 谁受影响

以 `workerRouteSettings: true` 挂载委派工具的部署，以及直接挂载 `worker-route-settings` 插件的部署。两者都不用的部署不受影响。

## 2. 需要改什么

1. 委派工具行：把 `workerRouteSettings: true` 换成 `routeSettingsNamespace: <namespace>`。
2. 设置行：加上 `namespace: <entry-id>`。entry id 与 namespace 必须相等；不一致时 `verify-cordis-config` 会让组合响亮失败。
3. 若要 planner 或 reviewer 角色，添加对应的 `subagent-planner-route-settings` / `subagent-reviewer-route-settings` 行，并在服务该角色的委派行上声明同一命名空间。子会话的持久化 `subagent/worker-route` 标记记录命名空间，安装因此保持精确：worker 行的监听器绝不会把 planner 子会话路由到 worker 路由。

## 3. 什么保持不变

存储路由的形态（`provider`、`model`、`reasoningEffort`）、模型页的工人路由区块、持久化的 `subagent/worker-route` 标记含义不变。标记指向 worker 命名空间的既有子会话继续从该命名空间的设置重新解析。
