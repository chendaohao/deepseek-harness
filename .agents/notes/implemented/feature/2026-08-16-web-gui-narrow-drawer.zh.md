# Agent Note: Web GUI 窄视口覆盖层 —— 侧栏抽屉、详情覆盖、触控悬停门控

Status: implemented

[English](2026-08-16-web-gui-narrow-drawer.md) | 中文

## Problem

Web GUI 是以桌面为主的三栏外壳。在手机浏览器中，自动折叠断点（SIDEBAR_AUTO_COLLAPSE = 1024）把侧栏收成 56px 的窄轨，但手动展开（narrowExpanded）会把会话列压缩到剩余轨道：393px 视口下中栏只有 113px，头部工具区和每一条工具行都溢出到屏幕右侧。还有两个触控缺陷叠加：详情让步链在 ~1056px 以下总是自动关闭详情栏，手机端无法查看工具详情；会话行的 HoverCard 在点击（pointerenter）后打开、永远无法离开（touch 没有 leave 事件），以 z-100 粘在界面上并吞掉点击（连抽屉遮罩都被它挡住）。另外上下文注入的 source 徽标在裁剪行里 flex: none，被硬切到半个字符；头部标题也被挤到屏幕外。

## Decision

**窄视口下，展开的侧栏和详情栏改为覆盖层抽屉；悬停预览对粗指针（触控）不再打开；头部与上下文徽标不再硬裁。**

- **侧栏抽屉**（`packages/client/ui-layout` 的 AppFrame 与模块 CSS）：断点以下，`narrowExpanded` 把侧栏渲染为 `position: absolute` 覆盖层（z-30，宽度 `min(preference, viewport - 64)`），其下是遮罩（z-24）；抽屉打开时网格的侧栏轨道保持 0px，中栏不再让步。显式 `grid-column` 定位保证遮罩/抽屉脱离网格流后中栏与详情栏仍落在自己的轨道上。点遮罩关闭抽屉；在抽屉里选中会话会自动关闭（仅窄视口的、跟踪当前 Session 的 effect，避免盖住刚打开的会话）；窄视口覆盖层不渲染拖拽把手。
- **详情覆盖层**（同文件）：窄视口下详情偏好渲染为右侧覆盖层（`min(preference, viewport - 24)`），共用同一个遮罩；（[详情会话生命周期记录](../bug-fix/2026-07-29-web-details-session-lifecycle.md) 中「切换会话即关闭」的生命周期保持不变）；此状态下让步求解器只看到关闭偏好，因此打开详情不再被静默自动关闭。（详情面板本身在两种平台上都无法从聊天里打开 —— `openDetails` 没有调用方；该缺口先于本次修改存在，另行跟踪。）
- **HoverCard 触控门控**（`packages/client/ui-primitives`）：`onPointerEnter` 对 `pointerType === 'touch'` 直接返回，点击不再能打开一个没有 leave 事件来关闭的预览卡。鼠标和手写笔行为不变；jsdom 规格通过不带 pointerType 的 pointerenter 派发，仍走悬停路径。
- **头部工具行**（`packages/client/ui-conversation` 的 ConversationRoot）：560px 以下工具簇移到独立一行（`flex: 0 0 100%`，标题簇为 `flex: 1 1 auto` —— 零基准会让 100% 基准的项留在第一行并把标题压到 0px），会话标题保留完整的第一行。
- **上下文徽标**（`ContextInjectionRow`）：生产者名徽标改为可收缩（`flex: 0 1 auto`），省略号生效而不是在 DisclosureRow 的 overflow 边缘硬切半个字符。

## Alternatives considered

- **限制展开侧栏宽度而不是覆盖** —— 否决：即使 70% 上限，360px 手机上也只剩 ~120px 会话区；抽屉是标准移动端模式，且中栏保持全宽。
- **纯 CSS 悬停抑制** —— 否决：卡片由 JS 定时器打开，只有指针类型门控能覆盖包括键盘模拟 enter 在内的所有路径。
- **matchMedia '(hover: hover)' 抑制** —— 否决：jsdom 的 matchMedia 恒为 false，会把所有 hover-card 规格关掉。

## Consequences

- 手机端会话在任何状态下都保持全视口宽度；抽屉与详情覆盖层盖在中栏之上、后有遮罩，点遮罩关闭。
- 桌面行为不变（已在线上 GUI 与 AppFrame 组件规格中验证；两个窄展开测试改写为抽屉契约，并新增窄详情覆盖层测试）。
- AppFrame 几何测试保留原有桌面让步断言。
- 需要重建：`@deepseek-ai/dsh-client-ui-layout` 与 `@deepseek-ai/dsh-client-ui-conversation` 的 bundle（插件注册表经 HMR watch 重新哈希），以及 `@deepseek-ai/dsh-web-frontend` 外壳（ui-primitives 经 vite alias 内联进外壳）。
- 手机端仍待处理：详情面板没有聊天入口（既有缺口）、长工具摘要省略后触控无法读取全文、代码块需要横向滚动、Tooltip 原语与 HoverCard 存在相同的点击后粘滞模式（严重度较低：下一次点击即消失）。