# vision/ - vision capability family

English | [中文](README.zh.md)

The vision stack for text-only model routes: a service contract that turns durable image attachments into text evidence (`ctx.vision`), a provider that streams observations through the harness LLM seam, an automatic request bridge that converts pasted images on text-only routes, and the model-facing `vision_observe` tool. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `vision/` | Service Definition: observation request/result types and the `vision/observed` session event vocabulary | `ctx.vision` |
| `vision-llm/` | LLM-backed `VisionService` implementation over a configured vision-capable model route | (registers `ctx.vision`) |
| `vision-bridge/` | Automatic conversion of image content in agent-loop requests on text-only routes, with durable evidence events | (no service — `llm/stream` + `session/event` listeners) |
| `tool-vision/` | Model-facing `vision_observe` tool: text evidence from local image files | (registers on `ctx.tools`) |

The core relationship to the existing image path: `read_image` hands the *image itself* to the current model and therefore requires a vision-capable route; `vision_observe` and the bridge hand the *evidence text* to a separate vision model and work on any route. The bridge converts user-pasted images at request time without rewriting history — the `user/message` events keep the images (the UI gallery keeps rendering them), and each observation is recorded as an ignorable `vision/observed` event so the converted request stays reconstructable from the session log.

The LLM-backed provider needs a vision-capable route registered on the harness LLM seam, typically an `llm-pi-ai` profile declaring `input: [text, image]` for its model (credentials, retry policy, and streaming all belong to that adapter).

The subsystem reference is [docs/subsystems/vision.md](../../docs/subsystems/vision.md).
