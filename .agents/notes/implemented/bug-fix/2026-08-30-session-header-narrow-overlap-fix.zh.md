# Agent Note: 会话头部控件在手机宽度下重叠

Status: implemented

[English](2026-08-30-session-header-narrow-overlap-fix.md) | 中文

## 问题

在手机宽度视口下，会话头部把两个固定宽度的控件组渲染在同一 flex 行中并溢出：标题簇（面包屑 + 模式徽标 + 来自 `ui-jobs` 的后台任务触发器）和 `.headerUtilities` 中的 Session 日志按钮都是 `flex: none`，因此当面包屑收缩到零时，簇的内容（徽标约 68px + 任务触发器约 100px）溢出到工具组上。任务触发器（"N 个后台任务"）和 Session 日志按钮重叠约 56×28px，导致 Session 日志按钮在任务触发器下方无法点击。

## 决定

在 `@media (max-width: 640px)` 下（与 composer 工具栏相同的断点），标题行堆叠成两行：会话标题独占一行，模式徽标（`ui-agent-preset` 标签）、后台任务触发器（`ui-jobs`）和 Session 日志按钮（`session-log-export`）三个控件共享其下的操作行：

- `ConversationSession.tsx` 将 `headerActions` 从 `titleCluster` 移到新的 `.actionsRow` 兄弟元素中，与 `headerUtilities` 并列；窄视口下 `.titleRow { flex-direction: column }` 把标题堆叠在操作行之上，桌面端两者保持一行。
- 操作行上的每个控件都参与 flex 收缩：徽标保持完整的预设名（窄断点下 `flex: 0 0 auto`，因此 "PTC 模式" 永不省略）、任务计数压缩、Session 日志按钮去掉最小宽度（`min-width: 0` + 标签省略）。在任何手机宽度下操作行都不会换行或溢出。

随后修正了行的 flex 分配，使 crumbs 无法挤压控件：`.titleCluster` 按内容尺寸（`flex: 0 1 auto`，承受挤压且其 crumbs 省略），`.actionsRow` 保留剩余空间但不收缩（`flex: 1 0 auto`），窄断点把操作行钉住（`flex: none`），三个控件在长 crumbs 下也绝不会压缩消失。

桌面端（\>640px）保持原始单行布局不变。

## 验证

通过 mobile-preview 代理对真实 GUI 使用 Playwright，会话头部有 10 个实时后台任务：

- 402-310px vw 扫描：crumb（标题）在自己的行保持完整 170px；徽标保持完整 68px 的预设名（"PTC 模式"，每个宽度下 `truncated: false`）；任务触发器（72→15px）和 Session 日志（92→57px）在操作行吸收挤压，每个宽度下 `overlapping: false`；头部高度 110px（两行）。
- 1270px vw：`titleRowDirection` 保持 `row`，头部高度 76px，crumb（300-470）、任务触发器（822-930）、Session 日志（1075-1192）在同一行——桌面端不变。
- `packages/client/ui-conversation/tests`：335/335 通过。

## 备选方案

**让每个控件各占一行（`titleRow { flex-direction: column }` + 簇内部换行）。** 拒绝——虽然可行但浪费垂直空间（头部约 143px）：三个控件在徽标和任务触发器收缩后可以舒适地共享一行，这正是最终设计。

**让簇继续包含操作并只在原地收缩。** 拒绝——簇的 `flex: 1` 会先吸收所有收缩压力，Session 日志工具永远不会压缩，任务触发器被压成省略号；把操作移出簇、与工具共享一行，让 flex 在三个控件之间均匀分配可用宽度。

**在 `ui-conversation` 的 CSS 中让任务触发器收缩（省略号/仅图标）。** 拒绝——触发器由 `ui-jobs` 插件通过 `conversation.session.header.actions` 插槽贡献；在 `ui-conversation` 的 CSS 中收缩它会耦合两个包，而且无助于同样溢出的模式徽标。

## 结果

手机宽度下的会话显示完整标题独占一行，模式徽标、后台任务触发器、Session 日志按钮共享其下的一行可压缩操作行——每个控件在 330px 及以上宽度都完全可见可点，代价是窄视口下头部变为两行（约 110px 对比 76px）。桌面和平板布局不变。335 项 ui-conversation 测试套件保持全绿。

## 相关

- [Two-row composer toolbar splits on the wrong nesting](2026-08-30-composer-toolbar-two-row-nesting-fix.zh.md) —— 与 composer 工具栏相同的 640px 断点约定；两个修复共享窄视口布局体系。
