# Agent Note：视觉观察能力缝——文本路由上的证据桥接图片输入

状态：已实施

简体中文 | [English](2026-08-14-vision-observation-seam.md)

## 问题

DeepSeek 官方 adapter 是纯文本的，因此 DeepSeek 路由的 harness 无法看图：`read_image`（把图片本身交给当前模型）在模型未声明 `image` 输入的路由上拒绝，用户消息中的粘贴图片使请求以 `UNSUPPORTED_CONTENT` 失败。社区用仓库外的桥接插件填补了这一空白；harness 需要第一方能力缝，让部署无需替换 adapter 即可获得视觉。

## 决策

新增能力家族 `packages/vision/`，含四个包：`ctx.vision` 服务定义（观察契约 + `vision/observed` 事件词汇）、基于 LLM 能力缝的 Provider（`vision-llm`，把观察流式发送到配置的视觉能力路由）、请求桥接（`vision-bridge`，转换文本路由上 agent-loop 请求中的图片内容）、以及 `vision_observe` 工具（`tool-vision`）。

桥接在 `llm/stream` waterfall 中转换，位于 agent-loop 不变量之后：只处理确切路由模型缺少 `image` 输入的 agent-loop 请求，把每个图片批次替换为视觉模型的证据文本，并经同一 LLM 能力缝派发转换后的请求（新对象，不标记为 agent-loop 请求，因此它通过不变量与桥接自身——无需重入防护）。`user/message` 事件保持原样，UI 画廊继续渲染图片。

**重建契约。** 循环不变量把请求与日志派生消息比对，而转换后的请求不是日志派生的内容——因此它替换的证据必须可重建。每次观察追加为 `vision/observed`，这是仅日志、非 surface 的事件，信封标记 `ignorable`：模型可见内容的重建从不读取它，没有该词汇的读取方可安全跳过（图片通过各自的 `user/message` 事件留在 surface 上）。桥接把该事件作为证据缓存读回，重启后的进程复用已记录的观察。这是 [会话日志版本机制 note](2026-08-10-session-log-version-mechanism.md) 预留的 `Session.append` ignorable 表面的第一个用户。

**apply 期间的服务访问。** Loader 条目并行启动（`EntryGroup.update` 以 `Promise.allSettled` 结算兄弟启动），因此 `vision-llm` 的 fiber 运行时视觉路由的 adapter 可能仍在注册。路由校验因此发生在首次观察而非加载时——仍然是 loud（`VISION_UNCONFIGURED` 指明路由与修复方法）。本家族的函数插件导出 `name`/`inject`/`Config`/`apply` 且无 default export，遵循 postmortem 中的 Loader namespace 规则。

## 后果

- 文本路由回答携带图片的消息；DeepSeek 部署通过 `llm-pi-ai` + `vision-llm` + `vision-bridge`（可选 `tool-vision`）在 `cordis.yml` 中增加视觉——无需替换 adapter。
- 视觉能力路由原生透传：桥接解析确切路由模型，仅在缺少图片输入时转换，`read_image` 与原生图片块继续可用。
- 观察失败以该路由的 `LlmError` 呈现，流入循环既有的重试机制。
- `vision_observe` 仅在 `tools`/`fs`/`vision`/`attachments` 全部挂载时注册（硬注入——该包只拥有一个工具）。

## 备选方案

- **替换 adapter（社区做法）**——包装或替换文本 adapter 把图片序列化为证据，日志保持原样，但绕过 LLM 能力缝且循环不变量无法重建；桥接的追加事件设计让转换后的请求可重建。
- **pre-step 消息改写**——在消息进入日志前改写 `user/message` 内容会把图片移出 surface（UI 画廊从这些事件渲染），因此桥接改在 `llm/stream` 边界转换，surface 保持完整。
- **加载时路由校验**——Loader 条目并行启动，provider 加载时视觉路由的 adapter 可能仍在注册；校验移到首次观察，仍然 loud。

## 验证

- 逐包单元覆盖（路由门控、分批、缓存、事件追加、HMR 卸载）。
- Keyless Loader 组合（`examples/vision-agent`）以 mock 视觉路由启动真实树，验证能力缝元数据、工具注册与观察往返。
- 桥接的转换/重建关系在包测试中配合真实 `SessionStore` 与 adapter 验证。