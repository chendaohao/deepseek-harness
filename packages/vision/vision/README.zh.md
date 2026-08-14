# @deepseek-ai/dsh-vision

简体中文 | [English](README.md)

视觉观察能力缝：把持久化图片附件转换为文本证据的服务契约，以及 `vision/observed` 会话事件词汇。本包是 [视觉能力家族](../README.md) 的服务定义，不包含运行时行为。

## 服务

### `ctx.vision`（抽象 `VisionService`）

- `observe(request, signal?): Promise<VisionObservation>` —— 观察一组持久化 `ImageAttachmentRef`，返回文本 `evidence`（以及 Provider 报告时的 token 计量）。服务是纯能力：从不写会话事件。记录由消费方负责——工具结果自带记录，请求桥接追加 `vision/observed`。
- `visionRoute: { provider; model }` —— 该观察器使用的 Provider 路由与模型，声明出来以便消费方无需了解 Provider 配置即可归属观察。
- `maxImagesPerRequest: number` —— 单次请求最多观察的图片数（部署解析），消费方据此分批。

实现方在其加载的 fiber 上注册服务（卸载时自动注销）。

## 事件

### `vision/observed`

仅日志、非 surface，事件信封标记 `ignorable`：模型可见内容的重建从不读取它，没有该词汇的读取方可安全跳过（图片通过各自的 `user/message` 事件留在 surface 上）。消费方追加它，使转换后的模型请求可从日志重建——即桥接图片输入的"模型可见 ⟺ 可记录"不变量。

负载为 `{ turn?, step?, messageId?, attachments, evidence, vision, usage? }`；确切声明见 [docs/subsystems/vision.md](../../../docs/subsystems/vision.md#the-reconstruction-record)。

## 错误

`VisionError` 携带稳定的机器路由代码：`VISION_UNCONFIGURED`（无可用的视觉路由）、`VISION_OBSERVE_FAILED`（观察基础设施失败）、`VISION_TOO_MANY_IMAGES`（超过批次上限）、`VISION_EMPTY_REQUEST`（未提供图片）。Provider 级失败以该路由自己的 `LlmError` 呈现。

## Model Experience

间接地，经由拥有观察请求与证据文本的 Provider 与消费方；定义包自身不携带模型绑定文本。

#### KV Cache 效果

无直接失效；命名消费方拥有各自的请求前缀变化。

## Known Limitations and Deferred Work

- **无本地观察**——能力缝只定义远程模型观察；本地 OCR/视觉 Provider 留待出现消费方时再补。