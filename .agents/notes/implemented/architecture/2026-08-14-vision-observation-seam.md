# Agent Note: Vision observation seam — evidence-bridged image input on text-only routes

Status: implemented

English | [中文](2026-08-14-vision-observation-seam.zh.md)

## Problem

DeepSeek's official adapter is text-only, so a DeepSeek-routed harness could not see images: `read_image` (which hands the image itself to the current model) refuses on routes whose model does not declare `image` input, and a pasted image in a user message made the request fail with `UNSUPPORTED_CONTENT`. The community filled the gap with out-of-repo bridge plugins; the harness needed a first-party seam so deployments could add vision without replacing adapters.

## Decision

A new capability family `packages/vision/` with four packages: the `ctx.vision` Service Definition (observation contract + `vision/observed` event vocabulary), an LLM-backed provider (`vision-llm`) that streams observations through the existing LLM seam to a configured vision-capable route, a request bridge (`vision-bridge`) that converts image content in agent-loop requests on text-only routes, and the `vision_observe` tool (`tool-vision`).

The bridge converts at the `llm/stream` waterfall, after the agent-loop invariant: it only touches agent-loop requests whose exact routed model lacks `image` input, replaces each image batch with the vision model's evidence text, and dispatches the converted request through the same LLM seam (a fresh object, unmarked as an agent-loop request, so it passes the invariant and the bridge itself — no re-entrancy guard). The `user/message` events stay untouched, so the UI gallery keeps rendering the images.

**Reconstruction contract.** The loop invariant compares the request against the log-derived messages, and the converted request is not what the log derives — so the evidence it replaced must be reconstructable. Each observation is appended as `vision/observed`, a log-only, non-surface event marked `ignorable` in its envelope: reconstruction of model-visible content never reads it, and a reader without the vision vocabulary can safely skip it (the images stay on the surface). The bridge reads the event back as its evidence cache, so a restarted process reuses recorded observations. This is the first user of the `Session.append` ignorable surface the [session log versioning note](2026-08-10-session-log-version-mechanism.md) reserved.

**Service access during apply.** Loader entries start in parallel (`EntryGroup.update` settles sibling starts with `Promise.allSettled`), so the vision route's adapter may still be registering when `vision-llm`'s fiber runs. Route validation therefore happens at the first observation, not at load — still loud (`VISION_UNCONFIGURED` names the route and the fix). Function plugins in this family export `name`/`inject`/`Config`/`apply` with no default export, per the Loader namespace rule in the postmortem.

## Consequences

- Text-only routes answer image-bearing messages; DeepSeek deployments add vision via `llm-pi-ai` + `vision-llm` + `vision-bridge` (and optionally `tool-vision`), all in `cordis.yml` — no adapter replacement.
- Vision-capable routes pass through natively: the bridge resolves the exact routed model and only converts when image input is absent, so `read_image` and native image blocks keep working.
- Observation failures surface as the route's `LlmError` and flow through the loop's existing retry machinery.
- `vision_observe` registers only while `tools`/`fs`/`vision`/`attachments` are all mounted (a hard inject — the package owns one tool).

## Alternatives considered

- **Adapter replacement (the community approach)** — wrapping or replacing the text adapter to serialize images into evidence keeps the log untouched but bypasses the LLM seam and cannot be reconstructed by the loop invariant; the bridge's appended-event design keeps the converted request reconstructable.
- **Pre-step message rewriting** — rewriting `user/message` content before it enters the log would drop the images from the surface (the UI gallery renders from those events), so the bridge converts at the `llm/stream` boundary instead, where the surface stays intact.
- **Load-time route validation** — loader entries start in parallel, so the vision route's adapter may still be registering when the provider loads; validation moved to the first observation, still failing loud.

## Verification

- Unit coverage per package (route gate, batching, caching, event append, HMR disposal).
- Keyless Loader composition (`examples/vision-agent`) boots the real tree with a mock vision route and proves the seam metadata, tool registration, and an observation round trip.
- The bridge's conversion/reconstruction relation is exercised in package tests with the real `SessionStore` and adapters.