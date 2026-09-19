# Agent Note: 模型页与模型选择器共用一个每设备提供方顺序

Status: implemented

[English](2026-09-11-shared-provider-order-across-model-surfaces.md) | 中文

本说明让模型选择器采用[模型设置页](../../../../packages/client/ui-settings-models/README.zh.md)已经持久化的提供方顺序，并把该存储移到两个界面都可导入的包中。

## Problem

模型设置页允许拖动提供方行，形成按设备保存于 `localStorage`、键为 `dsh:provider-order` 的顺序。模型选择器——composer 位与 `/model` 弹窗——此前按 Host 目录的注册顺序列出提供方，因此同一设备上的两个界面对于哪个提供方排在最前并不一致。

该顺序的归属位置也不对。`provider-order.ts` 位于 `ui-settings-models`，而功能插件不得运行时导入另一个功能插件的值，选择器因此无法读取它。`@deepseek-ai/dsh-client-ui-primitives` 正因同一原因已经持有共享的 `recent-models` 存储。

## Decision

把提供方顺序存储——`PROVIDER_ORDER_KEY`、`readProviderOrder`、`writeProviderOrder` 与 `applyProviderOrder`——移入 `@deepseek-ai/dsh-client-ui-primitives`，这是两个功能都可导入的窄静态归属方。`ui-settings-models` 通过该导出读写，只保留自身的拖拽几何 helper（`reorderedProviderIds`）。

两个选择器界面都对已加载的目录分组应用 `applyProviderOrder`。composer 位在每次打开时持有的状态中保存该顺序，并在菜单打开时重新读取，因此在设置页的一次拖动会影响到选择器的下一次打开；`/model` 弹窗在构建选项时读取该顺序。存储顺序中缺席的提供方保持其目录顺序，并排在已定位的提供方之后。同一包中的 `RECENT_LIMIT` 把「最近使用」分区限制为 5 条，恢复了[模型选择器恢复搜索/最近使用/折叠说明](../../implemented/feature/2026-08-31-model-selector-search-recent-effort-memory.zh.md)所记的上限；本说明原先设定的 3 条后来已被回退。子代理模型白名单卡片也按同一顺序对其候选项分组，因此一次拖动会作用于所有列出提供方的界面。

## Alternatives considered

- **把顺序留在 `ui-settings-models`，由选择器导入它。** 否决：功能插件导入另一个功能插件的运行时值正是客户端分层所禁止的；共享运行时代码属于 `ui-primitives`。
- **在 Host 侧排序提供方，使所有客户端一致。** 拖拽功能落地时已否决，此处不变：该顺序横跨两个设置命名空间，在文档中没有共同归属，且配对（转发）客户端对设置只读，Host 副本从手机端无法写入。该顺序是显示偏好而非模型事实，因此同样不进入会话日志。
- **手机与主机共用一个顺序。** 否决：它们是各自拥有独立 `localStorage` 的浏览器，共享副本需要新的可写 Host 偏好 API，并且会让一个屏幕上的重排改变另一个屏幕。真正重要的「一份」是按设备的，由该设备上的所有界面共享——本次改动正是让它成立。
- **在显示处而非存储处限制「最近使用」条数。** 否决：存储会持续增长，且每个读取方都要重复该上限。

## Consequences

模型页与两个选择器界面在同一设备内对提供方顺序保持一致，之后新增的提供方仍排在已排序行的后面。`RECENT_LIMIT` 为 5，存储中更长的列表在下一次读取时被截断。该存储成为 `ui-primitives` 的公开导出；设置包不再持有它。
