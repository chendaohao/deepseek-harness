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

- 点击麦克风说话；说完自动发送（也可再点一次结束）。
- 回复流式进入聊天并按句朗读；代码块永不朗读。回复以 Markdown 渲染（代码块、列表、链接），工具活动以可展开的行内条目出现在对话流中。
- agent 工作期间点击麦克风 = 停止朗读并取消回合（打断）。
- 审批与 agent 提问以内联答题卡呈现。
- 设置：识别与朗读语言（中文/English）、自动朗读开关。
- 暗色模式跟随系统主题；App 图标为黑底 DeepSeek 鲸鱼标。

## 检查

`pnpm --filter @deepseek-ai/dsh-mobile-app typecheck` 运行 App 自带的严格 `tsc --noEmit`；仓库的 oxlint/覆盖率门禁按设计排除这一原生工具链 App（其逻辑在 [packages/client/mobile](../../packages/client/mobile/README.md)，拥有完整覆盖率）。

## 已知限制

- **配对凭证存于设备钥匙串**——沿用主机 30 天 cookie 与按日 ticket 语义：隧道重启或 `--remote-reset` 后需重新扫码。
- **仅支持点击说话**——免提连续聆听（每轮回复后自动再听）尚未实现。
- **语音引擎是平台自带的**——质量与可用性随设备与系统语言包而异；暂未接入服务端 ASR/TTS。
- **expo-speech-recognition 跟随 Expo SDK 56**，而 App 在 SDK 57（模块声明宽松 peer 依赖）；关注 SDK 57 版本发布。
