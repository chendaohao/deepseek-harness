# Agent Note：移动端 P1/P2——图片、语音交互、会话、模型、计划/待办

Status: implemented

[English](2026-08-16-mobile-p1-p2-capabilities.md) | 中文

## 问题

界面对齐（[mobile chat UI note](2026-08-16-mobile-chat-ui-web-alignment.md)）补上了视觉差距，但 App 仍缺能力面：没有图片输入、没有免提回路、无法切换会话或模型、看不到计划模式与待办。要回答的问题是：/api 协议能否在不改宿主的前提下全部承载。

## 决策

**除推送通知外，全部走既有 /api 协议；移动端投影与 Expo 壳扩展了能力面。**

- **图片附件。** `session.prompt` 本就接受图片内容部件（规范 base64；宿主校验、保存并把持久化 `ImageAttachmentRef` 回显）。`submitContent(parts)` 发送文字+图片提示词，且不做纯文字式的乐观回显；实时 `user/message` 回显把图片引用投影到消息行，`downloadImage` 经 `session.attachment` 拉取为 data URI（App 内按附件 id 缓存）。输入区新增选择器（相机/相册，expo-image-picker + expo-image-manipulator，JPEG ≤1600px）。
- **语音交互。** 麦克风按住说话（按下聆听、松开发送）、点按打断；连续聆听（`autoListen`）在每轮回复结束后自动重启麦克风，除非有审批/提问待决或仍在朗读；TTS 语速与音调（0.5..2.0，夹取）经 speaker 端口流入 expo-speech。
- **会话。** `sessions.list` / `sessions.create` + 新的 `switchSession`（重置视图并重启流，历史重取重建新会话）；头部按钮打开会话面板（[易用性改进](2026-08-16-mobile-ui-ergonomics-pass.md)后为带标题的抽屉）。
- **模型选择。** `session.models`（目录 + `current`）与 `session.selectModel`；设置面板列出会话模型并记住最近选择（内存态）。
- **计划/待办面板。** 客户端折叠 `plan/mode`（经 plan-mode 包的 SessionEventMap 声明合并获得类型）与 `todo/write` 进快照；UI 渲染计划横幅与待办面板。
- **i18n。** 一套小号中/英词典（`useI18n`，expo-localization 的 `useLocales`）替换配对页与聊天页的全部硬编码文案；快捷指令 chips 出自同一词典。
- **暂缓：推送通知**——投递需要 FCM 加宿主经隧道的 webhook 配合；记为已知限制。

## 备选方案

- **扩展宿主协议**——否决：所需 RPC 全部已存在（`sessions.attachment`、`session.models`、`session.selectModel`、`plan/mode`、`todo/write`），只是投影此前丢弃了它们。
- **本地会话**——否决：切换必须从宿主重建历史；`switchSession` 复用既有历史/水印机制。
- **用 react-native-slider 调语速/音调**——否决：步进按钮把依赖面保持在最小。

## 后果

- 公开视图词汇增长（`SessionSummary`、`ModelOption`、`TodoItemView`、`PromptPart`、speaker 的 rate/pitch）；`SpeechSpeakerPort.speak` 签名变化，所有调用方一并更新。
- 图片提示词刻意跳过乐观回显：用户消息行在宿主回显时出现（本地没有可去重的引用）。
- 计划模式类型依赖 plan-mode 包的声明合并：`dsh-client-mobile` 新增 `dsh-plan-mode`（纯类型）与 `dsh-attachment`（类型）依赖。
- 100% 覆盖门禁覆盖全部新分支（图片失败路径、会话/模型失败、守卫）。
