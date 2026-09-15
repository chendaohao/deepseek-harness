# Agent Note: 双行输入栏工具栏因嵌套错误而无法分栏

Status: implemented

[English](2026-08-30-composer-toolbar-two-row-nesting-fix.md) | 中文

## 问题

2026-08-30 的双行输入栏修复（"two-row composer toolbar puts the primary actions on the bottom row"）的目标是让窄视口下的输入栏工具栏分成两行：trailing 组（模型座、上下文环、主操作）沉到底行、先填满并右对齐、发送按钮在最右，tools 组（附件/访问/计划）占据顶行。其机制是一个 flex 容器，直接子元素依次为 trailing 组和 tools 组，行容器使用 `flex-wrap: wrap-reverse`，tools 使用 `order: -1`：`wrap-reverse` 把第一个子元素（trailing）沉到底行、把第二个（tools）提到顶行，而 `order: -1` 保持单行时的视觉顺序（tools 在左、trailing 在右）。

实现把 `<div className={css.tools}>` 渲染在了 `<div className={css.trailing}>` **内部**，而不是作为它的兄弟元素，导致行容器只有一个 flex 子元素。`wrap-reverse` 和 `order: -1` 都需要两个兄弟子元素才能生效；只有一个子元素时工具栏永远不会分栏——所有手机宽度都渲染成单行，tools 组嵌套在 trailing 组内部。

## 决定

把 tools 组从 trailing 组中移出，使两者都是行容器的直接子元素，与提交所描述的 CSS 机制一致。仅修改 `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`，无 CSS 改动。

## 验证

通过 mobile-preview 代理对真实 GUI 使用 Playwright（视口扫描 412/375/360/340/320/300 设备像素）：

- 修复后 `row` 有两个直接子元素（`trailing`、`tools`）；修复前 `row` 只有一个子元素，`tools` 嵌套在 `trailing` 内。
- 单行宽度（402-330 vw）：tools 在左（81-159）、trailing 在右（222-369）、发送按钮最右——`order: -1` 翻转生效。
- 分栏宽度（310/290 vw）：行高从 42px 增至 76px，工具栏确实分栏了，但分栏结果**上下颠倒**——trailing 渲染在 tools 之上（top 515 对 555），当时被误读为成功；由[行归属修复](2026-08-30-composer-toolbar-two-row-inverted-placement.zh.md)纠正。
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`：72/72 通过。

## 备选方案

**让 tools 组留在 trailing 组内部并接受单行。** 拒绝——这正是出问题的已发布状态：任何手机宽度下工具栏都不会分栏，而且提交自身的机制（两个 flex 兄弟、`wrap-reverse`、`order: -1`）成了死代码，会误导下一位读者以为分栏生效了。

**恢复合并前的单行规则而不是双行拆分。** 拒绝——双行拆分是既定方向（2026-08-30 的修复将其描述为窄视口的修复），嵌套纠正后即可正常工作；回退到永远单行会丢弃已发布的意图。

## 结果

窄视口下的工具栏会分成两行，但伴随本提交一起发布的全局 `order: -1` 让两组落在了相反的行上——上方机制段落描述的是意图中的排布，而非实际发布的归属。[行归属修复](2026-08-30-composer-toolbar-two-row-inverted-placement.zh.md)用 `row-reverse` + `wrap-reverse` 加窄屏 order 重置纠正了行归属；嵌套修复本身（行容器的两个直接兄弟元素）仍然有效。桌面和宽屏移动端布局不变（`@media (max-width: 640px)` 块只在断点以下生效）。72 项 input-bar 测试套件保持全绿，因此座席分发、顺序或无障碍契约均未改变。

## 相关

- [双行输入栏工具栏把两组渲染到了相反的行上](2026-08-30-composer-toolbar-two-row-inverted-placement.zh.md) —— 纠正了本提交 CSS 机制产生的行归属；这里记录的兄弟结构修复仍然有效。
- [Mobile composer toolbar single-row and model menu](../feature/2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.zh.md) —— 本提交的 CSS 所扩展的窄视口工具栏规则；合并重应用记录记载了双行拆分所基于的 0.1.2 之后的结构。
