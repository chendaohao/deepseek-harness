# Agent Note: 后台任务菜单在手机上溢出；任务过程中输入框消失

Status: implemented

[English](2026-08-30-jobs-menu-overflow-and-composer-disappear.md) | 中文

## 问题

两个仅限移动端的会话头部与输入框缺陷，发生在后台任务运行期间：

1. **任务列表菜单溢出视口。** `JobListAction` 的弹出层是相对触发器 `position: absolute; left: 0`，触发器位于头部的操作行上。在手机上触发器可能靠近右边缘，因此 336px 的菜单溢出右边缘（例如 402px 视口中触发器在 left 152 时菜单右缘到 488——超出屏幕 86px），看起来像打不开。

2. **任务运行中输入框消失，只有刷新页面才能恢复。** 尚未定位根因：在 Playwright 探测中，任务运行、滚动、切换会话时输入框（sticky 座）都保持可见；报告者观察到手机端任务中途输入框消失。正在调查的候选机制：`settling` 输入框隐藏路径（`openState === 'loading'` 且会话非 summary-blank）、`ui-approval` 的 `ApprovalPanel` 接管（`pendingInteraction` 卡住）、或 `ui-subagent` 对 one-shot/continuable 会话的只读输入框接管。

## 决定

1. **窄视口下让任务菜单以触发器为中心居中**，镜像模型选择菜单的姿态：在 `@media (max-width: 640px)` 下，`.menu { left: 50%; transform: translateX(-50%) }`。现有的 `max-width: min(400px, calc(100vw - 32px))` 保证它在任何手机宽度下都在视口内。

2. **输入框消失：推迟到根因定位。** 在此记录，让下一个会话从上面的候选列表继续，而不是从头重新调查。

## 验证

通过 mobile-preview 代理对真实 GUI 使用 Playwright，会话有 10 个实时后台任务：

- 402px vw：菜单 left 20-356，中心 188 == 触发器中心 188，完全在视口内。
- 350px vw：菜单 left 13-331，中心 172 == 触发器中心 172，完全在视口内。
- 任务运行期间每 2 秒采样一次输入框可见性，持续 30 秒，覆盖滚动位置（顶部/中间/底部）和会话切换：座始终可见（`visibility: visible`，卡片 top 779）——这些探测未复现消失场景。

## 备选方案

**保持菜单左对齐并依赖 `max-width`。** 拒绝——336px 宽度减去 32px 视口边距后，只要触发器位于右边缘约 34px 以内就会溢出，而这是头部操作行上的常见情况。

**窄视口下用 `right: 8px; left: auto` 钳制菜单。** 拒绝——右对齐把菜单右缘钉在视口上，但与位于行中间的触发器视觉脱节；以触发器为中心（模型菜单的惯例）保持锚定关系。

## 结果

任务菜单现在在触发器下方居中打开，并在任何手机宽度下完全位于视口内，移动端可访问列表。输入框消失缺陷仍未解决，附有已记录的候选列表；修复在后续变更中落地。

## 相关

- [Session-header controls overlap on phone widths](2026-08-30-session-header-narrow-overlap-fix.zh.md) —— 本菜单所锚定的头部操作行布局；相同的 640px 断点约定。
