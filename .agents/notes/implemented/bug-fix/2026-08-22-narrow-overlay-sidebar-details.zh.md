# Agent Note: 窄视口下侧栏/详情面板改为浮层，hero 行支持换行

Status: implemented

[English](2026-08-22-narrow-overlay-sidebar-details.md) | 中文

## 问题（Problem）

在真实手机视口（360/390/412px）上实测，Web GUI 的三栏框架在移动输入控件上有三处失效：

1. 在窄视口展开侧栏会把中间栏挤到约 68px——composer 文本框完全不可用。
2. 详情面板在手机上无法打开：让步链把窄屏请求一路让到零宽度，于是点工具行什么也不显示，而零宽列仍在视口外画出一道 1px 的边框接缝。
3. 空白会话的 hero 行（工作区 chip + agent 预设位 + git-graph 分支 chip）横向溢出：分支 chip 锚定在该行绘制的右边缘上，延伸到屏幕外。

## 决策（Decision）

宽桌面保持契约冻结的让步几何；在窄视口（< SIDEBAR_AUTO_COLLAPSE = 1024）下，展开的面板不再挤压中间栏，而是作为浮层浮在其上方：

- AppFrame 在窄视口且面板展开时渲染 data-sidebar-overlay / data-details-overlay。网格保持折叠栏加整宽中间栏；面板按契约宽度（侧栏 280px，详情 min(100%, 360px)）绝对定位，并带点击关闭的遮罩（data-shell-backdrop）。窄屏浮层不渲染拖拽手柄。
- DetailsPanel 不再自绘 border-left；该边框归列所有，而 data-details-collapsed 本来就会移除它，接缝随之消失。
- heroWorkspaceRow 增加 flex-wrap: wrap 与合并后的 gap。

git-graph 分支 chip 归插件所有（@linxin666/dsh-client-ui-git-graph）；已安装的 0.2.5 bundle（src + lib/client.js）就地打补丁：当 hero 行放不下 chip 时，改为落到 hero 行下方的普通流（below row），而不是绝对锚定到屏外。已安装的 dsh-ssh 与 dsh-task-board bundle 增加 640px 媒体查询，把输入字号提到 16px（iOS 聚焦缩放阈值）；task-board 的列在手机上收窄为 minmax(170px, 1fr) 泳道。

## 备选方案（Alternatives considered）

- **窄宽度下继续让侧栏挤压中间栏，配一个更小的 composer。** 被否决：68px 的中间栏根本放不下输入控件；浮层恢复了整宽 composer，同时保留可点按的栏。
- **hero 行满时隐藏分支 chip。** 被否决：分支选择器是空白会话的主控件（仓库感知）；在手机上悄悄删掉它等于静默移除能力。below-row 回退让它保持可见可达。
- **把插件输入字号无条件提到 16px。** 被否决：紧凑的 13px 承载桌面宽度预算；640px 媒体查询只在 iOS 聚焦缩放会触发的地方提高字号。

## 影响（Consequences）

- 宽度偏好从不被改写：重新拉宽后仍恢复拖拽宽度；既有的 wide-closed-narrow 测试现在断言浮层而不是被挤压的轨道。
- 插件改动落在 profile 安装（~/.dsh/profiles/web）——即部署面。本机的 dsh-web-ui 全家桶仓库检出是另一个世代（0.1.x），未做回迁。

## 验证（Verification）

- app-frame.client.spec.tsx：窄屏切换断言 data-sidebar-overlay、宽度 280、无手柄；新增用例覆盖遮罩点击关闭与窄屏详情浮层的开/关。ui-layout + ui-conversation 套件通过（528 个测试）。
- 无头 Chromium 在 390/412px 下对活服务器：分支 chip 完全在视口内，侧栏浮层打开、遮罩关闭后恢复整宽 composer，详情列为零宽且无接缝，SSH 与 task-board 搜索输入为 16px。
