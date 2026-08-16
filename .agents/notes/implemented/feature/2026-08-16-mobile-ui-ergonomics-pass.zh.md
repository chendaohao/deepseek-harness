# Agent Note：移动端易用性改进——标题、审批、滚动与图标集

Status: implemented

[English](2026-08-16-mobile-ui-ergonomics-pass.md) | 中文

## Problem

[P1/P2 能力轮](2026-08-16-mobile-p1-p2-capabilities.md)之后，App 有了能力但没有易用性：会话面板显示的是 `sessionId.slice(-8)`（wire 上本就带着宿主机算好的标题）；审批卡片只显示工具名（帧上带着模型 `reason` 与被门控的 `callId`）；多选题第一次点按就提交单选答案；会话列表在每次布局变化时强制 `scrollToEnd`，翻阅历史会与自动滚动打架；头部与附件控件是文字字形（☰ ⚙ 📎 🎤）；两块屏幕都没适配刘海安全区。桌面 Web GUI 早已解决其中信息设计的一半（带标题的侧栏行、带理由与命令的审批面板、按工具的卡片预览、回到底部按钮）。

## Decision

**以视图投影扩展 + 应用侧易用性一轮收口；/api 协议不动。**

- **投影透传**（`packages/client/mobile`）：`SessionSummary` 携带宿主机的 `title`（取自列表行 `projections.values.title`，经 session-title 包的映射增强取得类型——与 web runtime 相同的 type-only 依赖模式）与 `cwd`；`PendingApproval` 携带 `reason` 与 `callId`；`PendingQuestionItem` 携带 `header`、`detail`、`multiSelect` 与选项 `description`。每个字段都已在 wire 上，折叠只是不再丢弃。
- **审批卡片对齐**（`apps/mobile`）：警示条 + 模型理由作标题 + 由 `callId` → `ToolStatusLine.argumentsText` 连接出的被门控命令（与 web `ApprovalPanel` 同一连接，在应用侧计算，帧/调用到达顺序无关）。控制器的乐观清除已给出一次性按钮语义；传输失败会恢复卡片。
- **提问卡片**：单选点击即答；多选本地勾选后一并提交。选项描述渲染在标签下。
- **滚动行为**：`onScroll` 追踪是否贴近底部；自动滚动（快照 effect 与 `onContentSizeChange`）仅在贴近底部时保持生效，用户滚离后出现"回到底部"按钮。发送提示词会重新武装自动滚动。
- **会话面**：头部显示当前会话的列表标题（每次切换刷新）；会话抽屉列出标题、工作目录末段、相对时间与运行中圆点，支持新建/切换。
- **工具行**：首行预览正在执行的命令或文件（按序尝试 `command`/`file_path`/`path`/`pattern`/`query`，从参数 JSON 解析）；展开详情以等宽块渲染命令并带复制、逐行键值参数、有界结果摘要。状态用 spinner/对勾/叉形图标而非文字。
- **图标与外观**：web 的 `ic_ds_*` SVG 集逐字移植为 `react-native-svg` 组件（`src/components/Icon.tsx`），替换全部文字字形；新增应用依赖 `react-native-safe-area-context` 驱动头部/输入区 inset；麦克风键在聆听时脉动、agent 工作时变为停止键；配对屏接入主题与安全区（此前硬编码浅色）。
- **Markdown 代码块**：用 `react-native-marked` 的 renderer 覆写为块级代码加语言标签与复制按钮。

## Alternatives considered

- **为更丰富的审批改宿主机**——否决：审批帧本就带 `reason`/`callId`；缺的命令是应用侧从已折叠的工具行就能完成的连接。
- **以无类型 record 断言读 title 投影**——否决：session-title 包的 client 命名空间增强给出带类型的 `title` 键且零运行时导入；断言会在本地重述 wire 形状。
- **底部"未读"横幅替代回到底部**——否决：未读计数需要已读追踪状态，App 没有其归属；单一入口已覆盖翻阅历史场景。
- **全部图标自绘**——否决：逐字移植 web 集保持两客户端同一视觉语言，并继承 figma 源路径。
- **TTS 语速/音调用滑杆**——沿用上一轮的步进器：依赖面保持小。

## Consequences

- `dsh-client-mobile` 依赖 `dsh-session-title`（type-only，client 命名空间），与 `dsh-plan-mode` 并列；tsconfig 引用与包依赖沿用 runtime 先例。
- 新视图字段全部为加性；100% 覆盖率门禁覆盖每个分支（有/无标题行、reason/callId 存在性、多选投影）。
- 头部标题来自列表并在每次切换时刷新：宿主机会话中途生成的标题要等下次开抽屉或切换才出现（`session/projection` 推送帧仍未折叠——若将来要实时标题，此处是核心包的已知延展区）。
- 图标移植是 web 集的一次性快照；web 新图标需手动再移植。
- 安全区处理引入 `react-native-safe-area-context`（Expo 锁定 `~5.7.0`）为应用依赖；核心包保持无 React。
- 验证仍靠真机（Expo）；仓库的浏览器 GIF 演示技能不覆盖原生 App。
