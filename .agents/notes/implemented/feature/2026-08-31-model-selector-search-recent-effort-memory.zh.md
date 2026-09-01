# Agent Note: Composer 模型选择器恢复搜索/最近使用/折叠，并新增按路由的推理强度记忆

Status: implemented

[English](2026-08-31-model-selector-search-recent-effort-memory.md) | 中文

本说明扩展[模型选择器搜索、最近使用与供应商折叠](../../implemented/feature/2026-08-19-model-selector-search-recent-collapse.zh.md)决定到合并后的基线，并同时恢复 master 的按模型推理强度记忆。

## Problem

dev-workspace 合并 upstream master（dsh 0.1.2-alpha.1）时，composer 的模型位被解析为 master 的扁平提供方分组列表，分支自带的搜索框、最近使用分区与可折叠提供方被丢弃——这些正是让选择器在提供方增多时仍可用的设计。同一合并也丢掉了 master 的按模型推理强度记忆（`reasoningEffortExplicit`）：每次切换模型都会把新路由解析到适配器默认值，用户在该路由上显式选择的强度被丢弃，切回时又呈现默认值。合并后的树还残留死 CSS 类（`.search`、`.menuList`、`.groupToggle`、`.groupBadge`、`.groupChevron`）和孤儿 locale 键（`search.placeholder`、`search.empty`、`recent.title`、`effort.normalized`）。

## Decision

在合并基础上同时恢复两种能力。

**搜索、最近使用与可折叠提供方回到 composer 位**，与分支当初发布的形式一致（移动端远程面板本就保留着它们）：搜索框通过共享的 `modelMatchesQuery` 按模型 id/名称或提供方名称对目录做扁平过滤；置顶的「最近使用」分区重新提供当前目录仍公布的最近选择，按设备存于 `localStorage`（键 `dsh:recent-models`，上限 6 条），经 `useRecentModels` 读写；每个提供方可在自己的表头下折叠并显示模型数量角标。搜索、最近与折叠状态全部住在该位内，每次打开重置。键盘行为延伸到搜索框：ArrowDown 进入第一个选项，Escape 先清空查询再退出面板。`role="menu"` 保持合法，输入框位于其外。仅名称的行保持仅名称（分支「隐藏模型选择器描述」的决定不变）；只有恢复的交互与强度回退 toast 复用了之前孤儿化的键。

**按路由的推理强度记忆端到端回归。** `AgentDefaultModelConfig` 新增 `rememberedEffort` / `rememberEffort` / `forgetEffort`，基于 `agent-default-model` 设置分节中的 `reasoningEfforts` 映射（键为 `provider/model`）；`saveSelection` 保留该映射，默认值写入不会丢弃其他路由的选择。`session.selectModel` 载荷新增一个可选线上字段 `reasoningEffortExplicit`。宿主 `selectModel` 命令把强度维度拆成三种状态：普通切换（不带强度）先解析适配器默认值，存在记忆时再用记忆强度重新解析；显式强度选择经过校验并记录到解析后的路由；显式「提供方默认」选择清除该路由的记忆。记忆写入与默认选择保存一样是尽力而为——只读设置提供方不能使模型切换失败。由于 llm 运行时现在把不支持的强度归一化为适配器默认值而非拒绝，过期的记忆等级通过把恢复后的解析结果与记忆比对来识别，归一化掉时即被清除。composer 位与 /model 弹窗的普通选择只提交路由（不预填默认强度，以免每次切换覆盖记忆）；强度面板的选择携带 `explicitEffort: true`，被宿主归一化到模型声明默认值的选择通过瞬时 toast（`effort.normalized`）提示。

## Alternatives considered

- **保留合并后的 master 选择器，不做搜索/最近/折叠。** 否决：扁平列表在提供方稍多时就不好用，而共享 helper 与移动端表面早已存在——合并把它们变成了孤儿。
- **仅客户端内存级的强度记忆。** 否决：刷新即丢失全部选择；设置分节是既有的持久化接缝，且与默认选择的部署级范围一致。
- **把最近选择的强度带到没有记忆的路由。** 否决：强度是按模型的能力，模型对等级的划分不一致；跨路由套用上次选择会静默选中用户从未为该模型选过的等级。

## Consequences

composer 选择器重新能随提供方增多而扩展（输入过滤、从最近使用中选取、或折叠提供方），显式强度选择现在能跨模型切换与刷新存活于其所在的确切路由；切到没有记忆的路由仍呈现该模型的默认值。`session.selectModel` 载荷新增一个可选线上字段；发送旧载荷的既有客户端保持普通切换语义。四个此前孤儿化的 locale 键重新被使用。按模型记忆是部署级的（与默认选择同范围）；过期的记忆等级在该路由下一次普通切换时自愈。
