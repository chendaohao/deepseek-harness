# Agent Note: 后台任务菜单在手机上溢出；任务过程中输入框消失

Status: implemented

[English](2026-08-30-jobs-menu-overflow-and-composer-disappear.md) | 中文

## 问题

两个仅限移动端的会话头部与输入框缺陷，发生在后台任务运行期间：

1. **任务列表菜单溢出视口。** `JobListAction` 的弹出层是相对触发器 `position: absolute; left: 0`，触发器位于头部的操作行上。在手机上触发器可能靠近右边缘，因此 336px 的菜单溢出右边缘（例如 402px 视口中触发器在 left 152 时菜单右缘到 488——超出屏幕 86px），看起来像打不开。

2. **任务运行中输入框消失，只有刷新页面才能恢复。** 尚未定位根因：在 Playwright 探测中，任务运行、滚动、切换会话时输入框（sticky 座）都保持可见；报告者观察到手机端任务中途输入框消失。正在调查的候选机制：`settling` 输入框隐藏路径（`openState === 'loading'` 且会话非 summary-blank）、`ui-approval` 的 `ApprovalPanel` 接管（`pendingInteraction` 卡住）、或 `ui-subagent` 对 one-shot/continuable 会话的只读输入框接管。

## 决定

1. **窄视口下让任务菜单以视口为中心居中**（不是触发器）——触发器位于行中偏左时，触发器居中的菜单相对视口仍然偏。在 `@media (max-width: 640px)` 下，`.menu { position: fixed; top: 120px; left: 50%; transform: translateX(-50%) }`，与上下文面板相同的姿态。

2. **不要用操作行收缩裁剪弹出层。** 第一个实现给 `.headerActions { overflow: hidden }`（窄断点下）来容纳收缩的徽标/任务触发器；这也裁剪了绝对定位的任务菜单（绘制在头部行下方），导致 10 行内容在 DOM 中存在但从未绘制。移除 overflow；操作及其子元素上的 `min-width: 0` 已足以让行收缩而不裁剪弹出层。

3. **窄视口下让上下文占用面板留在视口内。** `ContextMeter` 面板经 portal 挂到 `document.body`，由 `useAnchoredPosition` 相对其 28px 圆环根定位（side `top`、gap 8、margin 12）：钩子写入内联 `left`/`top`，并在 resize、滚动、面板尺寸变化时把两者钳制进视口。这条钳制就是全部机制，264px 面板在任何手机宽度下都留在视口内、位于输入框上方。

4. **任务菜单也钉在视口中心，而不是触发器。** 触发器居中的菜单仍相对视口偏（触发器位于行中）：`@media (max-width: 640px)` 下 `.menu { position: fixed; top: 120px; left: 50%; transform: translateX(-50%) }`，与上下文面板相同的姿态。

5. **输入框消失：推迟到根因定位。** 报告者在重建这些 UI 时复现，即 client-HMR 热换路径。`client-hmr` 替换 `ui-conversation` fiber（registry-first 拆除、`entry.refresh()`），卸载并重挂对话插槽；vendor 注释记录了 dev-only 竞态（重建帧与在途引导到达重叠可能物化重建前的字节）以及 apply 失败留下 FAILED fiber 时直到下一个重建帧或页面刷新前没有输入框。Playwright 探测（重载、HMR 重建、会话切换均保持 `data-composer-card` 可见、phase `active`）未复现。候选机制已记录：`settling` 隐藏路径（`openState === 'loading'` 且会话非 summary-blank）、`ui-approval` 的 `ApprovalPanel` 接管（`pendingInteraction` 卡住）、`ui-subagent` 只读输入框接管、或 HMR fiber 交换失败导致对话插槽未挂载。

## 验证

通过 mobile-preview 代理对真实 GUI 使用 Playwright，会话有 10 个实时后台任务：

- 402px vw：任务菜单 left 20-356，中心 188 == 触发器中心 188，完全在视口内；菜单内容处 `elementFromPoint` 命中菜单的 `li`（内容实际绘制且可点击）。
- 340px vw：任务菜单 left 15-323，中心 == 触发器中心，完全在视口内，内容可点击。
- 390px vw：上下文面板 x 114-378、y 724-866（264x142），完全在 390x900 视口内，锚定边保留 12px，且未施加 `transform`；480px 与 640px vw 走同一路径，得到同样的 264x142。
- 1280px vw：上下文面板 x 839-1103、y 724-866，未触及视口边缘；任务菜单左对齐——桌面端不变。
- 任务运行期间每 2 秒采样一次输入框可见性，持续 30 秒，覆盖滚动位置（顶部/中间/底部）和会话切换：座始终可见（`visibility: visible`，卡片 top 779）——这些探测未复现消失场景。
- `packages/client/ui-conversation/tests` + `packages/client/ui-jobs/tests`：357/357 通过；`apps/web/tests/context-meter.e2e.ts`（现在由它拥有面板在 390/800/1280px 的视口摆放）：2/2 通过。

## 备选方案

**保持菜单左对齐并依赖 `max-width`。** 拒绝——336px 宽度减去 32px 视口边距后，只要触发器位于右边缘约 34px 以内就会溢出，而这是头部操作行上的常见情况。

**窄视口下用 `right: 8px; left: auto` 钳制菜单。** 拒绝——右对齐把菜单右缘钉在视口上，但与位于行中间的触发器视觉脱节；以触发器为中心（模型菜单的惯例）保持锚定关系。

**窄视口下用 CSS 居中上下文面板（窄断点下 `left: 50%; transform: translateX(-50%); bottom: 120px`）。** 已移除——portal 面板本身已带内联 `left`/`top`，断点的 `left: 50%` 在层叠中落败，而 `transform` 仍然生效，把面板从锚点左移自身宽度的一半；`bottom` 与内联 `top` 同时非 auto 又过度约束了解算高度，264px 面板塌成 24px 的 padding，内容溢出压住输入框。带该块时 390px vw 实测：x = −18、高度 24px。

## 结果

任务菜单在触发器下方居中打开，其行在任何手机宽度下都实际绘制且可点击；上下文面板在输入框上方打开，并在任何宽度下都留在视口内。桌面端保持两个表面的原始锚定布局。输入框消失缺陷仍未解决；报告者在重建这些 UI 时复现，指向 client-HMR 热换路径（`ui-conversation` fiber 替换导致对话插槽卸载重挂；vendor 注释记录了 dev-only 竞态与 apply 失败留下 FAILED fiber 的可能）。Playwright 探测（重载、HMR 重建、会话切换）均未复现。候选机制已记录；修复在后续变更中落地。

## 相关

- [Session-header controls overlap on phone widths](2026-08-30-session-header-narrow-overlap-fix.zh.md) —— 本菜单所锚定的头部操作行布局；相同的 640px 断点约定。