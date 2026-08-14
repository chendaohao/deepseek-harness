# @deepseek-ai/dsh-tool-vision

English | [中文](README.zh.md)

The model-facing `vision_observe` tool: reads a PNG/JPEG/WebP/GIF file, durably commits its bytes through the attachment service, and returns the text evidence a configured vision model produced for it.

Unlike `read_image` (which requires the CURRENT model route to accept image input), `vision_observe` works on text-only routes: the image never reaches the main model, only its evidence does. This makes it the complement to `read_image` for deployments whose main model cannot see images.

## Registration

The plugin loads only while all of `tools`, `fs`, `vision`, and `attachments` are mounted (a hard inject, unlike the conditional `read_image` registration in the multi-tool filesystem suite): without a durable attachment store the tool cannot commit image bytes, and without `ctx.vision` there is no observer.

## Tool

### `vision_observe`

Arguments: `file_path` (required), `question` (optional). The output carries `path`, `evidence`, and the committed `image` reference metadata. The rendered text envelope pins the evidence block:

```
<path>...</path>
<evidence>
...evidence text...
</evidence>
```

Execution gates every refusal before any filesystem I/O: non-empty path, image extension, mounted attachment service, accepted media type, then the regular-file read target (session-cwd-relative resolution, `fs/observed` events, byte caps from the attachment limits). The bytes are committed through `attachments.saveImage` (content-addressed, idempotent) before observation, so the evidence references a durable object even when the tool result is later recorded.

## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`vision_observe` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-vision), with snake_case arguments. The tool registers unconditionally once the plugin loads (there is no route-dependent gate — the tool is useful precisely when the main model cannot see images).

#### Token effect

No fixed guidance cost: the tool contributes only its schema. Each execution spends one observation request's tokens (see `dsh-vision-llm`).

#### KV Cache effect

None — the tool adds no system-prompt text.

## Known Limitations and Deferred Work

- **One image per call** — the tool observes the single file it reads; multi-image comparison is the bridge's batch behavior, not this tool's.
- **Cloud vision only** — evidence comes from the configured vision route; no local OCR fallback.