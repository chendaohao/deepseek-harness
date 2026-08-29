# Agent Note：手机端输入框工具栏单行排列，模型选择菜单相对 chip 居中

Status: implemented

[English](2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.md) | 中文

## 问题

在手机宽度视口下，输入框工具栏原本渲染成两行：附加/权限/计划控件占第一行，模型选择、上下文环和主操作换到自己的第二行（`packages/client/ui-conversation/src/client/skeleton/InputBar.module.css` 里既有的 `@media (max-width: 640px)` 规则给 `.trailing` 设了 `flex: 1 1 100%`）。两个独立的缺陷让这个问题更糟且难以修复：

- **恢复的活跃会话**的输入框带有上下文占用环（`ContextMeter`，28px），空白会话的 hero 状态没有——所以 trailing 组比任何空白会话测量到的宽度多出约 40px，只测 hero 状态会隐藏溢出。
- 输入框自己的左侧应用栏（手机上 56px）会压在任何向左展开的弹层下面：模型选择菜单锚定 chip 的 `right: 0` 向左展开，伸进了该栏并被部分遮挡。

## 决定

**窄视口工具栏通过不拉伸和收紧 gap 保持单行。** 在 `@media (max-width: 640px)` 块内：`.tools` 从 `flex: 1 1 auto`（会拉伸，并在权限 chip 与模型 chip 之间制造虚假的"大空白"）改为 `flex: none`；`.row`/`.tools`/`.trailing` 的 gap 收紧（row 8px→6px、tools 8px→6px、trailing 6px→4px）。wrap 保留为 375px 以下视口的安全阀。

**模型 chip 上限收紧，让整个 trailing 组放得下。** `ModelSelect.module.css` 的 `.trigger` `max-width` 从 `min(360px, 45cqw)` 改为 `min(360px, 38cqw)`：宽行仍最多给 360px，但 390px 手机的输入框行（约 292px）把 chip 限制在约 111px，让 trailing 组（模型 chip + 上下文环 + 主操作）在 375px 视口起就能排成一行。桌面不受影响（778px 行下 38cqw ≈ 296px，大于当前模型名需要的 168px）。

**窄视口下模型选择菜单相对 chip 水平居中。** `@media (max-width: 640px)` 把 `.menu` 从 `right: 0` 覆盖为 `left: 50%; transform: translateX(-50%)`，保留 `position: absolute; bottom: calc(100% + 8px)`，菜单仍直接位于 chip 上方、相对 chip 水平居中。此前尝试过的视口固定全屏居中（`position: fixed; left/top 50%; translate(-50%, -50%)`）被否决，因为菜单在视觉上脱离输入框、跑到了屏幕中间。

## 备选方案

**窄视口隐藏 `ContextMeter`。** 否决——对用户可见的修复不能移除功能；只要 `.tools` 不再拉伸、gap 收紧，空间本来就够。

**保留 `.tools` 拉伸，用 `margin-left: auto` 推挤 trailing 组。** 否决——这正是修复前的布局：拉伸的 tools 组让权限 chip 与模型 chip 之间的空隙显得巨大，而 trailing 组仍然溢出并换行。

**模型菜单相对视口居中（`position: fixed`、垂直屏幕中间）。** 否决——"太高了"：菜单脱离触发器跑到屏幕中央；需求是只做水平居中、锚定 chip。

## 后果

375px 及更宽的手机在**每一种会话状态**（空白 hero、活跃、恢复的活跃）下输入框工具栏都排成单行，上下文环完整保留；375px 以下由 wrap 安全阀退化为两行。模型选择菜单在每种手机宽度下都相对 chip 居中打开、避开左侧栏；桌面保持原有的右锚定位置。`pnpm run test:gui` 保持全绿（4102 个测试）。

## 测试

`pnpm run test:gui` 覆盖客户端套件。布局各分支通过 Playwright 在真实 Chromium 中于 360/375/390/412/430/1280px 视口验证：375px 起单行（`rowH: 42`、`sameLine` 为真）；恢复的活跃会话中上下文环存在（28px）；模型菜单在 375/390/412px 下既不被 56px 左侧栏遮挡也不超出视口；桌面（1280px）菜单位置与模型 chip 宽度（168px）不变。

## 相关

- [窄视口 plan chip 点击区域回归测试](../bug-fix/2026-08-06-plan-narrow-viewport-regression.md) — 既有 composer 控制行换行机制（`flex-wrap: wrap` + `margin-left: auto`）的来源；本次变更在其基础上把 ≤640px 视口的默认从"空间不足就换行"改为"尽量保持单行"，760-850px 的换行行为不受影响。
