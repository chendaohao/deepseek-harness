---
description: "Web GUI 的手机适配层：触摸尺寸、安全区内边距、侧栏滑动开关，以及把外壳钉在手机可视区顶部的文档滚动复位，仅对手机类设备生效。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-mobile

[English](README.md) | 中文

## 概述

手机上的 Web GUI 沿用桌面布局与桌面触控尺寸：没有 44px 控件下限，没有安全区内边距，输入框不是 16px 会让 iOS 聚焦缩放，也无法滑动打开侧栏。本包补上这层：规则限定在打上的 `data-dsh-mobile-layer` 属性内，经 `ctx.effect` 安装，关掉这一行即随插件 fiber 移除；同时把文档滚动偏移钉回零位，因为手机会在地址栏移动时滚动外壳本身。它不贡献插槽、控件或文案；侧栏开关与窄屏浮层几何在 `ui-sidebar` 和 `ui-layout` 里已有。

## 目录

- [生效条件](#when-the-layer-applies)
- [选择器约定](#selector-contract)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="when-the-layer-applies"></a>
## 生效条件

判据是手机类设备：主指针为触摸且不具备悬停能力；没有 `matchMedia` 的运行时回退到移动端 User-Agent。`(hover: hover)` 检查排在最前，所以笔记本触摸屏——指针是粗的，但能悬停——会被排除；给这种页面套触摸样式，会在一个同时有鼠标和键盘的设备上压缩桌面布局。

设置 `sessionStorage['dsh-remote-force-desktop'] = '1'` 并刷新，可让单个标签页退出该层，用于手机接外接显示器。会话存储被禁用时按未设置处理，该层保持开启，而不是让页面报错。

<a id="selector-contract"></a>
## 选择器约定

触摸样式表是文档级的，但通过 CSS Modules 的**局部名后缀**触达组件：客户端构建把模块编译成 `[hash]_[local]`（`packages/client/tsdown.client.ts`），因此 `[class$="_composerSeat"]` 能在不写哈希的情况下命中那一个组件的座位。规则集很小，每条选择器都指向拥有该行为的组件：

| 选择器 | 所属包 | 原因 |
|---|---|---|
| `[class$="_iconButton"]` | `ui-sidebar` | rail 控件渲染 24px 字形，手指需要 44px |
| `[class$="_composerSeat"]` | `ui-conversation` | 输入框字号（iOS 缩放）与 home 指示条内边距 |
| `[class$="_centerCol"]` | `ui-layout` | 横屏时两侧刘海避让 |
| `html` / `body` / `#root` 上的 `[data-dsh-mobile-layer]` | `ui-web`（`base.css`） | 外壳高度跟随动态视口，而不是布局视口 |

重命名这些局部类是有意为之的行为，会在其所属包里体现为 diff；上表就是届时要复查的清单。

<a id="model-experience"></a>
## 模型体验

无。本层只做呈现与设备判定：不组装任何提供商请求，不贡献提示词、schema 或工具结果，也不读取会话状态。

#### KV Cache 影响

无；本层从不组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **后缀选择器是约定，不是类型检查过的契约。** 重命名一个 CSS Modules 局部类会静默丢掉对应规则。上表是人工复查清单；构建不会因此失败。
- **本层只改样式，不改布局。** 窄屏几何、浮层侧栏、点击空白关闭，`ui-layout` 里都已经有了；本包不重复声明，所以手机布局的改动属于那个包，不属于这里。
- **软键盘上 Enter 仍然是发送。** 输入框的键位映射是 `ui-conversation` 拥有的冻结管线（普通 Enter 发送、Shift+Enter 换行），而手机键盘没有 Shift。改它是改框架，不是改插件；发送保持走发送按钮。
- **滚动复位是事后纠正，不是阻止浏览器滚动。** `visibilitychange` 后的一帧复位意味着回前台的首帧仍可能画在恢复出来的偏移上，随后才吸回顶部。
- **设备判据是传输层 `isPhoneWeb`（`api-gateway`）的有意副本。** 两者为何不共享，见 `src/client/device.ts` 的模块注释。

<a id="dev-note"></a>
### 不变量归属

不发布运行时不变式伴随件：本层不持有持久状态，其全部效果随插件 fiber 一并移除。

### 开发备注

<details>
<summary>手势为何是被动的</summary>

滚动安全是设计约束。监听器是 passive 的，从不调用 `preventDefault`，所以浏览器保有平移的所有权，手势只做观察。首次移动就以纵向为主的指针会被放弃，因此滚动永远不会被重新解释成开关；此外，打开要求触摸起始于左边缘区域，因为从页面中部开始的右滑更可能是选择文本或横向滚动。

</details>