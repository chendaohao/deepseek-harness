# Vision Observation

English | [中文](vision.zh.md)

The vision seam gives **text-only model routes** sight: durable image attachments are observed by a separate vision-capable model route, and the resulting text evidence is what reaches the main model. The seam owns the observation contract and the reconstruction record, never the image bytes themselves (those belong to the [attachment seam](attachment.md)).

Two consumers use the seam:

- **The request bridge** (`@deepseek-ai/dsh-vision-bridge`) converts image content in agent-loop requests on text-only routes at request time. The `user/message` events stay untouched (the UI gallery keeps rendering the images); each observation is appended as an `ignorable` `vision/observed` event so the converted request stays reconstructable from the session log.
- **The `vision_observe` tool** (`@deepseek-ai/dsh-tool-vision`) lets the agent explicitly observe a local image file and receive text evidence, complementing `read_image` (which requires the current route to accept image input).

Source: [`packages/vision/vision/src/index.ts`](../../packages/vision/vision/src/index.ts)

## The service contract

`ctx.vision` (abstract `VisionService`) is a pure capability: `observe(request, signal?)` turns durable `ImageAttachmentRef`s into text `evidence`, and never writes session events — the observing consumer owns recording (a tool result records itself, the bridge appends `vision/observed`).

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

The service also declares deployment-resolved capability metadata: `visionRoute: { provider; model }` (for attribution) and `maxImagesPerRequest` (for batch splitting).

The LLM-backed provider (`@deepseek-ai/dsh-vision-llm`) streams observations through `ctx.llm` to a configured vision-capable route — credentials, retry, and streaming belong to that route's own adapter (typically `llm-pi-ai` with `input: [text, image]` declared). Loading fails loud when the route cannot be resolved or the model does not declare image input.

## The reconstruction record

`vision/observed` is a log-only, non-surface event marked `ignorable` in its envelope: reconstruction of model-visible content never reads it, and a reader without the vision vocabulary can safely skip it (the images stay on the surface through their own `user/message` events). It exists so a bridged model request — whose image blocks were replaced by evidence text at the adapter boundary — stays reconstructable from the log, satisfying the "model-visible ⟺ logged" invariant. The bridge reads it back as its evidence cache, so a restarted process reuses recorded observations instead of re-observing history.

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

## Bridge conversion flow

1. A user pastes images; the host commits them through the attachment seam and appends the `user/message` event (images stay on the surface).
2. The loop assembles its request; the agent-loop invariant confirms it matches the log exactly.
3. The bridge's `llm/stream` listener (after the invariant, only for agent-loop requests) resolves the exact routed model: declared `image` input passes natively; otherwise each image-bearing message's images are observed in batches of `maxImagesPerRequest` (message text becomes the question; cached evidence is reused).
4. Each observation is appended as `vision/observed`, then the request is converted — image blocks replaced by the batch's evidence block — and dispatched through the same LLM seam.

The bridge never converts non-agent-loop requests (including its own vision calls), so no re-entrancy guard is required.

## Relationship to the native image path

| Route capability | Pasted image | `read_image` | `vision_observe` |
| --- | --- | --- | --- |
| Declares `image` input | Image blocks reach the model natively (bridge passes through) | Works | Works (redundant but harmless) |
| Text-only (e.g. `deepseek`) | Bridge converts to evidence; UI keeps the image | Refuses (existing gate) | Works — the intended path |

## Configuration example

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

Load order matters: `llm-pi-ai` before `vision-llm` (the provider validates the route at load), `vision-llm` before the consumers.

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