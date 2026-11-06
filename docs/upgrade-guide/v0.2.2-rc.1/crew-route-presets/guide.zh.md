---
kind: upgrade-guide
description: "编队 bundle 新增 subagent-route-presets 命名空间，模型页因此可以保存三个角色路由的命名组合，并一次整体切换。"
---

# 保存编队路由组合

[English](guide.md) | 中文

## 变更

模型页的编队路由区块多了一个组合选择器。一套组合是每个角色路由的命名快照：选中它就写入 worker、planner、reviewer 三个角色的路由命名空间，于是"编队跑在哪些模型上"的切换从改三行变成选一次。

存储落在新命名空间 `subagent-route-presets`，由编队 bundle 新增的一行提供：

```yaml
- id: subagent-route-presets
  name: '@deepseek-ai/dsh-tool-subagent/route-presets'
  config:
    presets: []
```

出厂列表为空。其余都不变：三个角色路由命名空间、它们的已存储值、durable 的 `subagent/worker-route` 标记，以及每个 `routeSettingsNamespace` 值都保持原语义。

## 迁移

1. 选了 `@deepseek-ai/dsh-crew` 的部署重启即可：bundle 会插入该行，选择器出现在角色行上方。
2. 从早于本版本的固定版本安装编队 bundle 的部署看不到选择器，因为 Host 不提供预设命名空间。把 `@deepseek-ai/dsh-tool-subagent` 与 `@deepseek-ai/dsh-crew` 一起升级。
3. 在编队 bundle 之外自行组合路由行的部署不提供预设命名空间，因此看不到选择器。它的路由照旧工作；组合功能的范围就是这个 bundle。
4. profile patch 里已经插入 `subagent-route-presets` 的部署不要再选编队 bundle：两行服务同一命名空间会让组合失败，和两行路由行的情况相同。
5. 在设置 → 模型页确认：带编队 bundle 时该区块在三个角色上方显示**模型组合**选择器；不带时选择器和角色行都不出现。
