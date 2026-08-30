# Agent Note: 双行输入栏工具栏把两组渲染到了相反的行上

Status: implemented

[English](2026-08-30-composer-toolbar-two-row-inverted-placement.md) | 中文

## 问题

嵌套修复（[双行输入栏工具栏因嵌套错误而无法分栏](2026-08-30-composer-toolbar-two-row-nesting-fix.zh.md)）恢复了两个 flex 兄弟元素，但发布出来的排布是反的：手机上 trailing 组(模型座、上下文环、主操作)渲染在**顶行**，tools 组(附件/访问/计划)在**底行**——与"主操作沉到底行、先填满、右对齐、发送最右"的目标恰好相反。嵌套修复笔记自己的验证数据其实已经显示了这一点（trailing top 515 在 tools top 555 之上），但被误读为成功。

根因：`.tools { order: -1 }` 在所有宽度下生效，而 `order` 决定行的装箱顺序。在 `flex-wrap: wrap-reverse` 下，tools 组因此被装进**第一个** flex 行，而 `wrap-reverse` 把第一行放到交叉轴末端——底部。窄屏单行渲染需要 `order: -1` 来实现 tools 在左的视觉顺序，所以它被设成了全局，但正是这个值反转了双行的行归属。

## 决定

只改 `packages/client/ui-conversation/src/client/skeleton/InputBar.module.css`（无 DOM 改动；JSX 中 trailing 组仍在 tools 之前），让每个宽度使用适合自己宽度的机制：

- 窄屏（`@media (max-width: 640px)`）：`.row` 改为 `flex-direction: row-reverse` + `flex-wrap: wrap-reverse`；`.tools` 重置为 `order: 0` 并用 `margin-right: auto` 把自己钉在左侧；`.trailing` 去掉宽屏用的 `margin-left: auto`。row-reverse 把 DOM 顺序在前的 trailing 组放到主轴起点（右缘）；wrap-reverse 把第一装箱行沉底——在 tools 的 order 重置恢复 DOM 装箱顺序后，第一行就是 trailing；auto margin 把 tools 钉在它自己那一行的左缘。同样的配对让单行保持 tools 在左、trailing 在右，因此窄屏单行不再依赖 `order`。
- 宽屏（>640px）：不变——`.tools { order: -1 }` 加 `space-between` 和 trailing 的 auto margin。

同一块里还删除了一条死声明 `row-gap: 8px`（始终被其后的 `gap` 简写覆盖）。

## 验证

对从重建后的 `lib/client.js` 产物中提取的真实编译 CSS 使用 Playwright，在 900/500/320 px 视口下用有代表性的控件宽度测量：

- 320px（分栏）：tools 在**顶行**左对齐（x=8，y=52）；trailing 在**底行**（y=86）右对齐到卡片边缘（right=312），发送最右、模型在组内最左。
- 500px（放得下）：单行，tools 在左（x=8）、trailing 在右（right=492）。
- 900px（宽屏）：单行，tools 在左、trailing 在右——与窄屏单行完全一致。

`input-bar.client.spec.tsx` 72/72，`tsc --noEmit` 与 oxlint 干净。

## 备选方案

**把 `order: -1` 收窄到宽屏，窄屏保持普通 `row` + `wrap-reverse`。** 拒绝——窄屏单行会渲染成 trailing 在左 / tools 在右（宽屏的翻转恰好丢在手机最需要它的地方），而且 DOM 顺序 `[trailing, tools]` 在单行内没有任何 margin 排布能在不用 `order` 或反转主轴的前提下恢复 tools 在左 / trailing 在右。

**按控件逐个换行而不是按组。** 拒绝——需求是组粒度的：主组先填满底行，单个控件不跨行交错。

## 结果

工具栏现在在所有宽度下都符合确认过的需求：一行时保持现有排布；两行时主组沉底、右对齐、发送最右，tools 占顶行、左对齐。宽屏布局与 DOM/Tab 顺序不变；改动仅限 CSS，座席分发与无障碍契约均未移动。

## 相关

- [双行输入栏工具栏因嵌套错误而无法分栏](2026-08-30-composer-toolbar-two-row-nesting-fix.zh.md) —— 恢复了本笔记 CSS 所修正的两个 flex 兄弟元素；其机制段落描述的是修复前会反转行归属的 `order: -1` 排布。
- [Mobile composer toolbar single-row and model menu](../feature/2026-08-25-mobile-composer-toolbar-single-row-and-model-menu.zh.md) —— 两次修复共同依赖的窄视口工具栏规则。
