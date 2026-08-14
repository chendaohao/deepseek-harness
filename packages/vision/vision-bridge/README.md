# @deepseek-ai/dsh-vision-bridge

English | [中文](README.zh.md)

The automatic vision bridge: converts image content in agent-loop requests on text-only model routes into text evidence from the configured vision observer, so pasted images keep working on models that cannot see them.

## How it works

On every `llm/stream` request that is an agent-loop request, carries image blocks, and targets a model that does not declare `image` input:

1. Each image-bearing user message's images are split into batches of `ctx.vision.maxImagesPerRequest`; each batch is observed with the message's text as the question (cached evidence is reused).
2. Each observation is appended as an `ignorable` `vision/observed` session event (message id, attachments, evidence, vision route, usage), so the converted request stays reconstructable from the session log.
3. The request is converted — every image block is replaced by the batch's evidence block — and dispatched through the same LLM seam.

The `user/message` events stay untouched: the UI gallery keeps rendering the original images, and the model-visible ⟺ logged invariant holds because the loop's own request is unchanged (the invariant compares it against the log) while the evidence it replaced is recorded in the appended events.

The model-facing evidence block pins its envelope:

```
<vision-evidence message-id="..." attachment-ids="...">
<content>
...evidence text...
</content>
```

Requests that are not agent-loop requests (hand-built calls, the bridge's own vision calls) pass untouched, so no re-entrancy guard is required. Vision-capable routes pass through natively — `read_image` keeps working — because the bridge only converts when the exact routed model lacks image input.

## Model Experience

### Converted request context

#### What the model sees

On a text-only route, an image-bearing request reaches the adapter with each image batch replaced by its evidence block; the rest of the messages are unchanged. The evidence text is the vision model's output (see `dsh-vision-llm`), not a fixed string.

#### Token effect

Per converted request: one observation request per uncached image batch (input = prompt + question, output = evidence), plus the main request itself unchanged. Cached batches (same message and attachments, recorded in the log) cost nothing.

#### KV Cache effect

The main request's prefix is unchanged by conversion, so provider-side prefix caching behaves as without the bridge.

## Known Limitations and Deferred Work

- **Text-only routes only** — models declaring `image` input receive images natively; the bridge never converts for them.
- **Observation failures fail the request** — a failed observation surfaces as the route's `LlmError` and flows through the loop's existing retry machinery; the request is never silently downgraded to a text-only guess.
- **Compaction may drop evidence events** — if a compaction removes `vision/observed` events, a later request re-observes the affected images (idempotent, but costs a vision call).
- **Repeated requests re-observe only misses** — evidence is cached per message + attachments from the session log; changing the observer prompt invalidates nothing until process restart (the log remains authoritative).