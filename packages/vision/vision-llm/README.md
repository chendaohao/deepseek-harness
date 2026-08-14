# @deepseek-ai/dsh-vision-llm

English | [中文](README.zh.md)

The LLM-backed `ctx.vision` implementation: streams observations through the harness LLM seam to a configured vision-capable model route. Credentials, retry policy, and streaming belong to that route's own adapter (typically `@deepseek-ai/dsh-llm-pi-ai`); this package never touches provider wire formats or keys.

## Config

```yaml
- id: vision-llm
  name: '@deepseek-ai/dsh-vision-llm'
  config:
    # LLM seam provider route that serves the vision model (e.g. an llm-pi-ai route).
    provider: openai
    # Exact model id on that route; the model must declare image input.
    model: gpt-4o-mini
    # System instruction sent with every observation request (default below).
    prompt: "You are a vision observer ..."
    # Maximum images observed in one request (default 4).
    maxImagesPerRequest: 4
    # Cap on observation output tokens; absent leaves the provider default.
    maxTokens: 512
```

The default observation instruction is stable, model-visible text:

> You are a vision observer for a text-only agent. Examine the image(s) precisely and describe their content as evidence another model will quote. Report visible text verbatim, layout and structure, objects, people, charts, numbers, and UI elements. Do not infer what is not visible. End with a one-line summary.

Loading fails loud when the route cannot be resolved or the model does not declare `image` input (`VISION_UNCONFIGURED`): an observation that can never succeed is a deployment misconfiguration, not a runtime surprise. Load `@deepseek-ai/dsh-llm-pi-ai` (or another adapter) with that route before this plugin.

## Model Experience

### Observation request context

#### What the model sees

Every observation request sends the configured `prompt` as the system slot and one user message whose content is the optional `question` text followed by the image blocks. The provider adapter resolves the durable image references into provider-native image input; the model's reply becomes the evidence text.

#### Token effect

Per observation: the system prompt plus question text as input tokens, and the evidence text (capped by `maxTokens` when configured) as output tokens. Batching multiple images into one request shares the system prompt across them.

#### KV Cache effect

The system prompt is prefix-stable while the configured `prompt` is unchanged, so provider-side prefix caching applies per route.

## Known Limitations and Deferred Work

- **No local fallback** — cloud vision only; a local OCR/vision provider is a future provider, not a mode of this one.
- **Route capability is the adapter's claim** — a model declaring `image` input whose endpoint refuses images fails mid-turn at the provider, per the LLM seam's capability contract.