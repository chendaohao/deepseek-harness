# vision/ - 视觉能力家族

简体中文 | [English](README.md)

面向纯文本模型路由的视觉栈：把持久化图片附件转换为文本证据的服务契约（`ctx.vision`）、通过 harness LLM 能力缝流式观察的 Provider、自动把文本路由上的粘贴图片转换为证据的请求桥接，以及面向模型的 `vision_observe` 工具。全部为**产品**包。

| 包 | 角色 | ctx key |
|---|---|---|
| `vision/` | 服务定义：观察请求/结果类型与 `vision/observed` 会话事件词汇 | `ctx.vision` |
| `vision-llm/` | 基于 LLM 能力缝的 `VisionService` 实现，走配置的视觉模型路由 | （注册 `ctx.vision`） |
| `vision-bridge/` | 自动把文本路由上的 agent-loop 请求中的图片内容转换为证据，并持久化记录证据事件 | （无服务——`llm/stream` + `session/event` 监听器） |
| `tool-vision/` | 面向模型的 `vision_observe` 工具：从本地图片文件产出文本证据 | （注册于 `ctx.tools`） |

与现有图片路径的核心关系：`read_image` 把*图片本身*交给当前模型，因此要求视觉能力路由；`vision_observe` 和桥接把*证据文本*交给独立的视觉模型，适用于任意路由。桥接在请求时转换用户粘贴的图片而不改写历史——`user/message` 事件保留图片（UI 画廊照常渲染），每次观察记录为可忽略的 `vision/observed` 事件，转换后的请求可从会话日志重建。

LLM Provider 需要在 harness LLM 能力缝上注册视觉能力路由，通常是声明 `input: [text, image]` 的 `llm-pi-ai` profile（凭证、重试、流式都属于该 adapter）。

子系统参考见 [docs/subsystems/vision.md](../../docs/subsystems/vision.md)。
