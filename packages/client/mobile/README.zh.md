# @deepseek-ai/dsh-client-mobile

[English](README.md) | 中文

DSH 移动语音 App 的平台无关核心：与 remote-access 配对门配对、复用既有 /api 协议的 wire 载体，以及语音对话状态机。Expo 壳（[apps/mobile](../../../apps/mobile/README.md)）注入设备语音（ASR/TTS）、fetch 与安全存储；本包不依赖 React、React Native 或 Node。

MobileApiClient 继承 @deepseek-ai/dsh-host-apiproxy/client 的 AbstractApiClient，因而继承全部协议不变量——rpcId 铸造/回显、信封打包/解包、zod 值解析、心跳容忍；本包只贡献平台侧：配对后的 base URL、手动携带的 dsh_remote cookie 头（RN fetch 没有 cookie jar）、Hermes 安全的 rpcId 来源、AbortSignal.timeout/any 静态方法垫片、把 401 标记为 UnauthorizedError，以及 WebSocket 下行开启器（网络服务器对事件路径的普通 GET 应答 426——载体的 SSE 形态只存在于进程内 handler）。socket 通过注入提供（设备端 RN WebSocket 支持头参数；测试与隧道 e2e 用 ws）。`pairWithHost` 可选携带设备名（`?name=`，折叠空白并截断到 64 字符），供主机设置页为绑定打标签。

VoiceChatController 拥有对话全流程：会话选择（复用列表或新建）、带 seq 水印的历史重建、实时事件折叠、聆听 → 转写 → 自动发送回路、打断（停止朗读 + 取消回合），以及围栏感知的 SpeakQueue——句子随流朗读，代码围栏永不朗读。审批与提问帧以待处理项呈现，App 通过 answerApproval/answerQuestion 应答（respond 回显帧 rpcId）。列表行携带宿主机的 `title` 投影与 `cwd`；待处理审批携带帧上的 `reason` 与被门控调用的 `callId`（与 `ToolStatusLine.id` 连接，卡片因此能显示命令）；提问项携带 `header`、`detail`、`multiSelect` 与选项描述。

## Model Experience

间接：经语音控制器转发的用户 session.prompt 文本——宿主机自有的会话事件词汇拥有全部模型可见呈现，设备转写与 TTS 朗读内容从不进入模型请求。

#### KV Cache effect

无：本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **重连时全量重取历史**——mux 流的 since 续传钩子宿主机侧尚未实现（v1），因此重连会重取历史尾部并靠水印去重。
- **语音引擎是设备自带的**——注入的 recognizer/speaker 端口就是未来替换为服务端 whisper 或云 ASR/TTS 的接缝；Expo 壳目前内置设备端实现。
- **会话复用取列表最新一项**——按会话管理 UI 属于 App，不在核心。
