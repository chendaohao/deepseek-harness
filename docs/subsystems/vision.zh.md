# 视觉观察

简体中文 | [English](vision.md)

视觉能力缝让**纯文本模型路由**获得视觉：持久化图片附件由独立的视觉能力模型路由观察，到达主模型的是生成的文本证据。能力缝拥有观察契约与重建记录，从不拥有图片字节本身（那些属于 [attachment 能力缝](attachment.md)）。

两个消费方使用该能力缝：

- **请求桥接**（`@deepseek-ai/dsh-vision-bridge`）在请求时把文本路由上 agent-loop 请求中的图片内容转换为证据。`user/message` 事件保持原样（UI 画廊继续渲染图片）；每次观察追加为 `ignorable` 的 `vision/observed` 事件，转换后的请求可从会话日志重建。
- **`vision_observe` 工具**（`@deepseek-ai/dsh-tool-vision`）让 agent 显式观察本地图片文件并取得文本证据，与 `read_image`（要求当前路由接受图片输入）互补。

Source: [`packages/vision/vision/src/index.ts`](../../packages/vision/vision/src/index.ts)

## 服务契约

`ctx.vision`（抽象 `VisionService`）是纯能力：`observe(request, signal?)` 把持久化 `ImageAttachmentRef` 转换为文本 `evidence`，从不写会话事件——记录由消费方负责（工具结果自带记录，桥接追加 `vision/observed`）。

```ts type-equiv
/** One observation request: durable image references plus an optional question. */
interface VisionObserveRequest {
  /** Durable images to observe, already committed through the attachment seam. */
  attachments: readonly ImageAttachmentRef[]
  /** Optional task-specific question steering the observer's description. */
  question?: string
  /** Cap on observation output tokens; absent leaves the provider default. */
  maxEvidenceTokens?: number
}
```

```ts type-equiv
/** The text evidence a vision observer produced for one observation request. */
interface VisionObservation {
  /** Model-facing text describing the observed images. */
  evidence: string
  /** Provider-reported token accounting when the adapter reported any. */
  usage?: { inputTokens: number; outputTokens: number }
}
```


服务还声明部署解析的能力元数据：`visionRoute: { provider; model }`（用于归属）与 `maxImagesPerRequest`（用于分批）。

LLM Provider（`@deepseek-ai/dsh-vision-llm`）通过 `ctx.llm` 把观察流式发送到配置的视觉能力路由——凭证、重试、流式都属于该路由自己的 adapter（通常是声明 `input: [text, image]` 的 `llm-pi-ai`）。路由无法解析或模型未声明图片输入时加载即失败。

## 重建记录

`vision/observed` 是仅日志、非 surface 的事件，信封标记 `ignorable`：模型可见内容的重建从不读取它，没有该词汇的读取方可安全跳过（图片通过各自的 `user/message` 事件留在 surface 上）。它存在的意义是让被桥接的模型请求——其图片块在 adapter 边界被证据文本替换——可从日志重建，满足"模型可见 ⟺ 可记录"不变量。桥接把它作为证据缓存读回，重启后的进程复用已记录的观察而非重新观察历史。

```ts type-equiv
/**
 * One completed vision observation: the durable evidence text a vision model
 * produced for the referenced images. Log-only, non-surface, and ignorable:
 * reconstruction of model-visible content never reads it, and a reader without
 * the vision vocabulary can safely skip it (the images themselves stay on the
 * surface through their own `user/message` events). Consumers append it so a
 * converted model request stays reconstructable from the log — the
 * "model-visible ⟺ logged" invariant for bridged image input.
 */
interface VisionObservedEvent {
  /** Turn of the observation's owning step when the consumer knows it. */
  turn?: number
  /** Step of the observation's owning step when the consumer knows it. */
  step?: number
  /** Message id of the observed user message when the consumer knows it. */
  messageId?: string
  /** The durable images the evidence describes. */
  attachments: readonly ImageAttachmentRef[]
  /** The model-facing evidence text produced for the images. */
  evidence: string
  /** The provider route and model that produced the evidence. */
  vision: { provider: string; model: string }
  /** Provider-reported token accounting when the adapter reported any. */
  usage?: { inputTokens: number; outputTokens: number }
}
```

## 桥接转换流程

1. 用户粘贴图片；host 通过 attachment 能力缝提交字节并追加 `user/message` 事件（图片留在 surface 上）。
2. 循环组装请求；agent-loop 不变量确认请求与日志严格一致。
3. 桥接的 `llm/stream` 监听器（位于不变量之后，仅处理 agent-loop 请求）解析确切路由模型：声明 `image` 输入则原生透传；否则每条携带图片的消息按 `maxImagesPerRequest` 分批观察（消息文本作为问题；命中缓存则复用）。
4. 每次观察追加为 `vision/observed`，然后请求被转换——图片块替换为该批的证据块——经同一 LLM 能力缝派发。

桥接从不转换非 agent-loop 请求（包括它自身的视觉调用），因此无需重入防护。

## 与原生图片路径的关系

| 路由能力 | 粘贴图片 | `read_image` | `vision_observe` |
| --- | --- | --- | --- |
| 声明 `image` 输入 | 图片块原生到达模型（桥接透传） | 可用 | 可用（冗余但无害） |
| 纯文本（如 `deepseek`） | 桥接转换为证据；UI 保留图片 | 拒绝（既有门控） | 可用——预期路径 |

## 配置示例

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-4o-mini
            input: [text, image]
- id: vision-llm
  name: '@deepseek-ai/dsh-vision-llm'
  config:
    provider: openai
    model: gpt-4o-mini
- id: vision-bridge
  name: '@deepseek-ai/dsh-vision-bridge'
- id: tool-vision
  name: '@deepseek-ai/dsh-tool-vision'
```

加载顺序很重要：`llm-pi-ai` 先于 `vision-llm`（Provider 在加载时校验路由），`vision-llm` 先于两个消费方。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxvision--visionservice-abstract-seam"></a>

### `ctx.vision` — `VisionService` (abstract seam)

Vision observation service: turn durable image attachments into text evidence without assuming the current model route can see images. The service is a pure capability — it never writes session events; the observing consumer owns recording (a tool result records itself, the request bridge appends `vision/observed`).

```ts cordis-catalog
/**
 * Observe one set of durable images and return text evidence.
 * @param request - the image references and optional steering question.
 * @param signal - optional cancellation for provider work.
 * @returns the evidence text and provider token accounting when reported.
 * @throws {@link VisionError} for observation failures; the provider route
 *   surfaces its own LlmError for request-level failures.
 */
abstract observe(request: VisionObserveRequest, signal?: AbortSignal): Promise<VisionObservation>
```

Source: [`packages/vision/vision/src/index.ts:51`](../../packages/vision/vision/src/index.ts)
<!-- END GENERATED cordis-surface -->