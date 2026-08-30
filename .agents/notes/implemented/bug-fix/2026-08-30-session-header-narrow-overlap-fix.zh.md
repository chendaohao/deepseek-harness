# Agent Note: 会话头部控件在手机宽度下重叠

Status: implemented

[English](2026-08-30-session-header-narrow-overlap-fix.md) | 中文

## 问题

在手机宽度视口下，会话头部把两个固定宽度的控件组渲染在同一 flex 行中并溢出：标题簇（面包屑 + 模式徽标 + 来自 `ui-jobs` 的后台任务触发器）和 `.headerUtilities` 中的 Session 日志按钮都是 `flex: none`，因此当面包屑收缩到零时，簇的内容（徽标约 68px + 任务触发器约 100px）溢出到工具组上。任务触发器（"N 个后台任务"）和 Session 日志按钮重叠约 56×28px，导致 Session 日志按钮在任务触发器下方无法点击。

## 决定

在 `@media (max-width: 640px)` 下（与 composer 工具栏相同的断点），将标题行垂直堆叠：`.titleRow { flex-direction: column; align-items: flex-start }`、`.titleCluster { flex-wrap: wrap }`、`.headerUtilities { margin-left: 0 }`。簇保持内部换行，徽标和任务触发器在超出簇宽时折行，工具行（Session 日志）落到自己的行——每个控件都完全可见可点。桌面端（\>640px）保持原始单行布局不变。

## 验证

通过 mobile-preview 代理对真实 GUI 使用 Playwright：

- 402px vw：任务触发器（152-253, top 45-73）与 Session 日志按钮（76-193, top 79-111）不再重叠（`overlapping: false`）；头部增高到 143px 以容纳堆叠的行。
- 1270px vw：`titleRowDirection` 保持 `row`，头部高度 76px，任务触发器（556-657）与 Session 日志（1075-1192）相距很远——桌面端不变。
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` + `packages/client/ui-jobs/tests`：94/94 通过。

## 备选方案

**让标题行换行（`flex-wrap: wrap`）而不是堆叠。** 拒绝——两组的宽度（簇 131px + 工具 117px）恰好填满 248px 的行，因此换行永远不会触发；重叠发生在簇内部，其子元素溢出到工具组上。

**让任务触发器收缩（省略号/仅图标）。** 拒绝——触发器由 `ui-jobs` 插件通过 `conversation.session.header.actions` 插槽贡献；在 `ui-conversation` 的 CSS 中收缩它会耦合两个包，而且无助于同样溢出的模式徽标。

## 结果

手机宽度下的会话头部控件垂直堆叠：标题/徽标行、后台任务触发器、Session 日志——每个都完全可见可点，代价是窄视口下头部更高（约 143px 对比 76px）。桌面和平板布局不变。94 项测试套件保持全绿。

## 相关

- [Two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.zh.md) —— 与 composer 工具栏相同的 640px 断点约定；两个修复共享窄视口布局体系。
