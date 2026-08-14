# vision-agent

English | [中文](README.zh.md)

Runnable demo of the [vision capability family](../../packages/vision/README.md): a text-only main model route still sees images through the request bridge (pasted images become text evidence) and through the `vision_observe` tool (local image files become text evidence). The vision model is a separate route on the LLM seam, typically `llm-pi-ai` with `input: [text, image]` declared.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   OPENAI_API_KEY=sk-…   # the vision route's key
#   DEEPSEEK_API_KEY=sk-… # the main model's key
pnpm dsh --profile web --patch examples/vision-agent/cordis.yml
```

Paste an image into the composer: the bridge observes it through the vision route and the main model answers from the evidence. Ask the agent to `vision_observe` a local file for the tool path.

## Composition

`cordis.yml` mounts the seam in load order: `llm` + `llm-pi-ai` (vision route), `attachment-local` (durable image bytes), `vision-llm` (validates the route at load), then the `vision-bridge` and `tool-vision` consumers. Swap the `openai` profile for any pi-ai route that declares image input; credentials resolve through the credential store per request.

## Keyless smoke

`tests/keyless-smoke.e2e.ts` boots the real Loader tree with a mock vision route (`tests/fixtures/`), proves the seam metadata, the `vision_observe` registration, and a real observation round trip through the attachment seam.
