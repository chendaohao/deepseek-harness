# @deepseek-ai/dsh-vision

English | [中文](README.zh.md)

The vision observation seam: the service contract that turns durable image attachments into text evidence, plus the `vision/observed` session event vocabulary. This package is the Service Definition of the [vision capability family](../README.md) and ships no runtime behavior.

## Service

### `ctx.vision` (abstract `VisionService`)

- `observe(request, signal?): Promise<VisionObservation>` — observe one set of durable `ImageAttachmentRef`s and return text `evidence` (plus provider token accounting when reported). The service is a pure capability: it never writes session events. The observing consumer owns recording — a tool result records itself, the request bridge appends `vision/observed`.
- `visionRoute: { provider; model }` — the provider route and model this observer uses, declared so consumers can attribute observations without knowing the provider's configuration.
- `maxImagesPerRequest: number` — the deployment-resolved maximum images observed in one request, used by consumers to split batches.

Implementations register the service on the same fiber they load on (disposal unregisters it automatically).

## Events

### `vision/observed`

Log-only, non-surface, and marked `ignorable` in the event envelope: reconstruction of model-visible content never reads it, and a reader without the vision vocabulary can safely skip it (the images stay on the surface through their own `user/message` events). Consumers append it so a converted model request stays reconstructable from the log — the "model-visible ⟺ logged" invariant for bridged image input.

The payload is `{ turn?, step?, messageId?, attachments, evidence, vision, usage? }`; the exact declaration is in [docs/subsystems/vision.md](../../../docs/subsystems/vision.md#the-reconstruction-record).

## Errors

`VisionError` carries stable machine-routing codes: `VISION_UNCONFIGURED` (no usable vision route), `VISION_OBSERVE_FAILED` (observation infrastructure failure), `VISION_TOO_MANY_IMAGES` (batch cap exceeded), `VISION_EMPTY_REQUEST` (no images supplied). Provider-level failures surface as the route's own `LlmError`.

## Model Experience

Indirectly, through the providers and consumers that own observation requests and evidence text; the definition package ships no model-bound text of its own.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **No local observation** — the seam defines remote-model observation only; a local OCR/vision provider is deferred until a consumer needs one.