# Agent Note: 模型选择器搜索、最近使用与供应商折叠

Status: implemented

[English](2026-08-19-model-selector-search-recent-collapse.md) | 中文

## Problem

composer 模型座位与手机远程弹窗都把按供应商分组的模型目录渲染成一个扁平纵向列表。配置了大量供应商和模型后,选定一个具体模型意味着逐个供应商往下滚;选择器无法支撑超过寥寥几项的规模。

## Decision

两个界面在共享的 `session.models` 目录上获得同一套三件套。搜索框按模型 id、模型名或供应商名(大小写不敏感子串)把目录拍平过滤;置顶的最近使用区块重新提供当前目录仍存在的最近选择;每个供应商在自己带模型数量徽标的标题下折叠。`/model` 命令弹窗与思考强度面板/区块保持不变。

搜索、最近与折叠状态每次打开重置、按界面隔离。最近使用的路由按设备持久化在 `localStorage`(key `dsh:recent-models`,上限 6 条,去重后最近优先),由 `@deepseek-ai/dsh-client-ui-primitives` 里的共享辅助承担——`readRecentModels` / `writeRecentModel` / `useRecentModels`——加上 `modelMatchesQuery` 这个两个界面共用、因此不会漂移的过滤实现。过期路由通过与目录求交集从展示中消失;存储靠上限保持有界,且从不喂给模型请求,因此不进会话日志。

## Alternatives considered

- **先选供应商再选模型的两级下钻。** 被否:每次选择多一次点击,搜索仍需扁平的命中视图。
- **用户配置收藏/置顶。** 被否:新增设置面;「在几个模型间切换」的场景靠最近使用即可覆盖,无需配置。
- **只做供应商折叠,不做搜索与最近使用。** 被否:折叠缩短滚动,但要找到模型仍需逐个展开供应商。

## Consequences

Web 下拉(`ModelSelect`)与手机弹窗(`ModelSheet`)在供应商很多时都可用:输入即过滤、从顶部最近使用里挑,或折叠不用的供应商。Web 键盘行为延伸到搜索框(ArrowDown 进入列表,Escape 先清查询再退面板)。ARIA 菜单结构把搜索框拆出 `role="menu"`,避免输入框成为非法的 menuitem。搜索与折叠状态每次打开重置;最近状态按设备持久化,且刻意不跨源共享(Web 宿主与手机 `/m` 页各自维护自己的列表)。
