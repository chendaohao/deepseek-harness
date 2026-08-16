# @deepseek-ai/dsh-mobile-app

[English](README.md) | 中文

DSH 移动语音 App：原生 Expo（React Native）客户端，通过 [remote-access 隧道](../../packages/remote/README.md) 与 DSH 主机配对，用语音对话——设备端语音识别把你的话变成提示词，回复实时流式呈现，设备端语音合成把回复读出来。全程走既有配对门与 /api 协议，不改任何宿主机插件。

## 环境要求

- 一台运行 `dsh web --remote` 且已配置模型的主机（App 只是通道，agent 在主机上运行）。终端会打印配对 URL 与二维码。
- 手机安装 Expo Go，或制作开发构建（`npx expo run:android` / `npx expo run:ios`）。
- Android 语音识别依赖 Google 应用的语音服务；iOS 使用系统 SFSpeechRecognizer。

## 运行

```sh
pnpm install
pnpm build          # builds @deepseek-ai/dsh-client-mobile for Metro
cd apps/mobile
npx expo start      # scan the Expo QR with your phone
```

随后扫描主机终端的配对二维码（或粘贴 `https://…/pair/<ticket>` 链接），开始说话。

## 在 GitHub Actions 上构建可安装的 APK

仓库自带 `.github/workflows/mobile-android-build.yml`：在 Actions 页签手动运行（可输入分支，默认 `master`）。它会检出工作区、用冻结 lockfile 安装依赖、构建 App 引用的全部 `lib/` 产物（`pnpm run build:lib` —— `dsh-client-mobile` 及其 host 侧依赖都通过 `lib/` 解析）、生成原生 Android 工程（`expo prebuild`）并组装 release 变体 APK，最后把 APK 作为 artifact 上传。必须用 release 变体：RN 的 Gradle 插件只为非 debuggable 变体打包 JS bundle，debug APK 需要可连接的 Metro 才能运行；Expo 生成的模板用平台调试密钥为 release 变体签名，无需任何密钥。

在手机上安装（已在 MIUI 14 / Android 12 验证）：

1. 打开该次运行的 artifact 页面，下载 `dsh-mobile-app` artifact（或开启 USB 调试后执行 `adb install -r app-release.apk`）。
2. 用文件管理器打开 APK；MIUI 会询问一次是否允许该来源安装（“安装未知应用”）。
3. 主机上运行 `pnpm dsh web --remote`，用 App 扫描终端打印的二维码，开始对话。

APK 使用平台调试密钥签名，可与 Expo Go 并存安装，个人构建无需任何签名密钥；生成的模板默认关闭混淆。

## 语音交互

- 按住麦克风说话，松开发送；agent 工作期间麦克风键变为明确的停止按钮（停止朗读并取消回合）。
- 连续聆听（每轮回复结束后自动开始聆听）是设置项之一。
- 回复流式进入聊天并按句朗读；代码块永不朗读。回复以 Markdown 渲染——块级代码带语言标签与复制按钮；工具活动以可展开的行内条目呈现正在执行的命令或文件，展开详情里可一键复制命令。
- 空会话是带开场提示词的引导页；列表只在贴近底部时自动滚动，向上翻阅后出现“回到底部”按钮。
- 可从相机或相册发送图片；agent 连同文字一起看到，消息行内渲染图片。长按任意消息可复制或分享。
- 头部显示当前会话标题与连接状态；会话抽屉列出主机会话（标题、工作目录、时间、运行状态），可切换或新建。
- 审批卡片显示模型理由与被门控的命令；agent 提问支持多选与选项描述；计划模式横幅与可折叠的待办清单以内联面板呈现。
- 设置里可选会话模型、识别与朗读语言、朗读语速与音调、自动朗读、连续聆听，并显示已配对主机。
- 界面文案跟随设备语言（中文/English）；暗色模式跟随系统主题；布局适配刘海屏安全区；App 图标为黑底 DeepSeek 鲸鱼标。

## 检查

`pnpm --filter @deepseek-ai/dsh-mobile-app typecheck` 运行 App 自带的严格 `tsc --noEmit`；仓库的 oxlint/覆盖率门禁按设计排除这一原生工具链 App（其逻辑在 [packages/client/mobile](../../packages/client/mobile/README.md)，拥有完整覆盖率）。

## 已知限制

- **配对凭证存于设备钥匙串**——沿用主机滑动 30 天不活跃窗口与按日 ticket 语义：连续 30 天未使用的设备自动解绑（任意使用都会刷新窗口），`--remote-reset` 后需重新扫码。配对会上报手机机型名，主机的 设置 → 远程访问 页按名称列出该设备。
- **无推送通知**——回合结束只在应用内提醒；推送需要 FCM 与宿主机 webhook 配合，暂缓实施。
- **图片按附件逐个加载**——消息图片经宿主附件往返下载，按附件 id 缓存。
- **语音引擎是平台自带的**——质量与可用性随设备与系统语言包而异；暂未接入服务端 ASR/TTS。
- **expo-speech-recognition 跟随 Expo SDK 56**，而 App 在 SDK 57（模块声明宽松 peer 依赖）；关注 SDK 57 版本发布。
