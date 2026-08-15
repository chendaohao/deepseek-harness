# Agent Note: Native mobile voice app consuming the remote-access pairing gate

Status: implemented

[English](2026-08-14-mobile-voice-app.md) | 中文

## Problem

[remote phone access Agent Note](2026-08-14-remote-phone-access.md) 让手机浏览器可以访问主机。但语音优先的移动体验仍需要一个真正的 App：iOS Safari 没有 SpeechRecognition，React Native 也完全没有浏览器语音 API，因此带设备端 ASR/TTS 的原生 App 是零后端实现语音对话的唯一路线。

## Decision

两块组成，宿主机零改动：

- **packages/client/mobile**（`@deepseek-ai/dsh-client-mobile`），平台无关核心。`MobileApiClient` 继承 `AbstractApiClient`（`dsh-host-apiproxy/client`），继承全部协议不变量（rpcId 铸造/回显、信封、zod 值解析、SSE 解码、心跳容忍），只贡献平台侧：配对后的 base URL、手动携带的 `dsh_remote` cookie 头（RN fetch 没有 cookie jar）、Hermes 安全的 rpcId 来源、`AbortSignal.timeout`/`any` 静态方法垫片，以及把 401 标记为 `UnauthorizedError`，以及 WebSocket 下行开启器（网络服务器对事件路径的普通 GET 应答 426；载体的 SSE 形态只存在于进程内 handler）。socket 通过注入提供——设备端用带头支持的 RN WebSocket，测试与隧道 e2e 用 `ws`。`VoiceChatController` 拥有会话选择（复用列表或新建）、带 seq 水印的历史重建加实时事件折叠、聆听 → 转写 → 自动发送回路、打断（停止朗读 + 取消回合），以及围栏感知的 `SpeakQueue`（随流朗读句子，代码围栏永不朗读）；审批/提问帧通过 `respond()` 应答。
- **apps/mobile**（`@deepseek-ai/dsh-mobile-app`，private），Expo SDK 57 壳。配对 = 扫描终端二维码 → `pairWithHost`（`redirect: 'manual'`）→ `dsh_remote` cookie 存入 `expo-secure-store`（钥匙串）。适配器：`expo-speech-recognition`（设备端 ASR）、`expo-speech`（设备端 TTS）、`expo/fetch`。屏幕：配对（扫码或手输 URL）、聊天（Markdown 消息、内嵌工具行、内嵌语音键的单一输入条、审批/提问卡片、设置）——界面对齐的后续决策见[mobile chat UI note](2026-08-16-mobile-chat-ui-web-alignment.md)。
- **仓库整合。** App 是私有 workspace 成员：`check-workspace-constraints` 白名单 `apps/mobile`，release 家族枚举跳过 private 清单，knip 有显式条目，oxlint 忽略该 App（它运行自己的 `tsc --noEmit`）。`packages/client/mobile` 是普通可发布的 client 包，处于每文件 100% 覆盖门禁之下。
- **测试。** 包单测（106 用例，每文件 100%）加 keyless e2e（`apps/web/tests/mobile-voice-app.e2e.ts`）：经 fake-cloudflared 隧道配对、建会话、订阅 mux WebSocket 流，并在回放模式下复用 fresh-round-trip 夹具跑完整语音回合，断言朗读输出包含 DONE。

## Alternatives considered

- **在现有 Web GUI 上做 PWA 语音**——拒绝：iOS Safari 没有 SpeechRecognition，iPhone 用户只剩 TTS。
- **服务端 ASR（whisper 或云）**——推迟：模型下载或 API key 换不来 v1 设备引擎已有的覆盖；recognizer/speaker 端口就是未来的接缝。
- **在 React Native 里复用 `dsh-client-connection`**——拒绝：它的 cordis 插件树、浏览器 bundle 语义与 `window`/`EventSource` 假设使 Metro 集成自成项目，而 apiproxy 载体本就传输抽象——继承只需一个文件。
- **流式 fetch 的 SSE 下行**——原生端拒绝：网络服务器只以 WebSocket 提供事件路径（普通 GET 应答 426；SSE 仅存在于进程内载体），带 cookie 头的浏览器式 WebSocket 开启器才是真实服务器的唯一通路。

## Consequences

- 配对 cookie 是设备钥匙串秘密；401 → 重新配对，隧道重启 → 重新扫码（按日 ticket 仍有效）。
- Android ASR 依赖 Google 应用的语音服务；README 已注明。
- 重连会重取历史尾部（宿主机 `since` 续传钩子 v1 未实现）并靠水印去重。
- App 的原生工具链按设计处于仓库级门禁之外；其逻辑在完全覆盖的包内。`expo-speech-recognition` 目前跟随 Expo SDK 56 而 App 在 SDK 57（宽松 peer）——关注 SDK 57 版本发布。
- 注入的 recognizer/speaker/fetch 端口是未来接入服务端或云语音的扩展接缝。