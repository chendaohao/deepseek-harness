# Agent Note：移动端聊天界面与 Web GUI 对齐

Status: implemented

[English](2026-08-16-mobile-chat-ui-web-alignment.md) | 中文

## 问题

DSH 语音 App 的聊天界面落后于 Web GUI（原始 App 决策见[mobile voice app note](2026-08-14-mobile-voice-app.md)）：回复只渲染纯文本、没有 Markdown；工具活动以脱离对话流的横向 chip 条呈现；输入区被大麦克风圆球和独立发送按钮割裂；配色只有写死的浅色；App 图标是 Expo 默认图标。

## 决策

**在不动 /api 协议的前提下，让移动端对话界面与 Web GUI 的信息架构对齐。**

- **客户端投影扩展**（`packages/client/mobile`）：`ChatMessage` 两个变体携带事件 `seq`；`ToolStatusLine` 扩展为富信息行——`status`（`running`/`done`/`error`）、原始 `argumentsText`、以及限制在 300 字符内的结果摘要 `resultSummary`（取首个文本块，递归进入嵌套的 tool-result 块）。历史回放与实时折叠共用同一代码路径；线上词汇不变。
- **ChatScreen 重写**（`apps/mobile`）：经 `react-native-marked` + `react-native-svg` 的 `useMarkdown` hook 渲染 Markdown（气泡内不嵌套 FlatList）；工具行按消息/工具 `seq` 排序内嵌进对话流；输入区收敛为单一输入条——内嵌语音键，发送键随草稿内容出现；审批/提问卡片与设置面板使用随系统深浅色切换的 token 化配色；按下麦克风有触感反馈；iOS 键盘避让输入条。
- **App 图标**：取自官网 favicon 的 DeepSeek 鲸鱼标重着色为白色，置于黑色圆角底上，另附 adaptive 前景；接入 `app.json`。
- **交付方式不变**：仍由 GitHub Actions 的 release 变体 workflow 构建可安装 APK。

## 备选方案

- **`react-native-markdown-display` 及其 fork**——否决：年久失修或落后；`react-native-marked` 声明支持 RN ≥ 0.76 且维护活跃。
- **用库自带的 FlatList 组件渲染 Markdown**——否决：虚拟化列表嵌套在聊天气泡内布局异常；`useMarkdown` hook 直接返回普通元素数组。
- **改宿主协议**——否决：会话事件本就携带参数、结果内容与错误标识，只是移动端投影此前丢弃了它们。

## 后果

- /api 协议与宿主表面不变；投影现在呈现 Web 本就拥有的参数、结果摘要与错误状态，工具行可继续生长出 Web 风格细节而无需再改线上词汇。
- 携带 seq 的消息与工具行是公开视图词汇：App 把它们合并为一条时间线，改动 seq 契约即改动视图类型。
- `react-native-marked` 与 `react-native-svg` 是新增 App 依赖（与 Expo SDK 57 匹配的版本）；Markdown 经 `useMarkdown` hook 渲染，气泡内永不嵌套虚拟化列表。
- 结果摘要限制在 300 字符以内；原始参数保持模型原样输出。
- 暗色模式跟随系统；两套配色收在一个主题模块里。
