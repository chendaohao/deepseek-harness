---
description: "Log-backed session pin state served to list surfaces, for users and maintainers choosing the pin service or debugging pin order."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-pin

English | [中文](README.zh.md)

## Summary

`dsh-session-pin` gives list surfaces a durable pin bit per session: `setPin(session, pinned)` appends a log-only `session/pin` event and returns the folded `SessionPinSnapshot` (`pinned`, `eventSeq`, `updatedAt`). The `pinned` projection (last-wins fold of `session/pin` events) serves the pin state list rows read; cold sessions receive it through the projection cache like `title` and `sessionListMetadata`. The pin rides the session event log, so it survives restarts and replays, and forks inherit the pin state of their seed prefix.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Session pin state

#### What the model sees

Nothing. `session/pin` is log-only and never enters the session surface, model prompt, tool schemas, or request prefix.

#### Token effect

`setPin` adds zero tokens to the main agent request.

#### KV Cache effect

None; pin events do not change the reconstructed message content or cache key.

## Known Limitations and Deferred Work

- Pinning is a human-facing verb; no model tool exposes it.
- The service appends blindly; callers that need idempotence read the folded state first (appending the current value again is harmless).

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
