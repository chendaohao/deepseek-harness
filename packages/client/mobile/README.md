# @deepseek-ai/dsh-client-mobile

English | [中文](README.zh.md)

Platform-neutral core of the DSH mobile voice app: pairing with the remote-access gate, the wire carrier over the existing /api protocol, and the voice conversation state machines. The Expo shell ([apps/mobile](../../../apps/mobile/README.md)) injects device speech (ASR/TTS), fetch, and secure storage; nothing here imports React, React Native, or Node.

MobileApiClient subclasses AbstractApiClient from @deepseek-ai/dsh-host-apiproxy/client, so every protocol invariant — rpcId mint/echo, envelope wrap/unwrap, zod value parsing, heartbeat tolerance — is inherited; this package contributes only the platform aspects: the paired base URL, the manual dsh_remote cookie header (RN fetch has no cookie jar), a Hermes-safe rpcId source, the AbortSignal.timeout/any statics shim, 401 branding as UnauthorizedError, and the WebSocket downlink openers (the network server answers plain GETs on the event paths with 426 — the carrier's SSE form exists only for the in-process handler). The socket is injected (RN WebSocket with header support on device; ws in tests and the tunnel e2e).

VoiceChatController owns the conversation: session selection (list-reuse or create), history reconstruction with a seq watermark, live event folding, the listen -> transcript -> auto-send loop, barge-in (stop speech + cancel the turn), and the fence-aware SpeakQueue that speaks sentences as they stream and never reads code fences aloud. Approval and question frames surface as pending items the app answers through answerApproval/answerQuestion (respond echoes the frame rpcId).

## Model Experience

Indirectly, through the user session.prompt texts the voice controller relays — the host's session event vocabulary owns every model-visible rendering, and device transcripts and TTS utterances never reach a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Full-history refetch on reconnect** — the mux stream's since resume hook is unimplemented host-side (v1), so reconnects refetch the history tail and rely on the watermark for dedupe.
- **Speech engines are the device's own** — the injected recognizer/speaker ports are the seam a server-side whisper or cloud ASR/TTS provider would replace; the Expo shell ships the on-device implementations.
- **Session reuse picks the newest listed session** — per-session management UI lives in the app, not the core.
