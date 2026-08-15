# Agent Note: Native mobile voice app consuming the remote-access pairing gate

Status: implemented

English | [中文](2026-08-14-mobile-voice-app.zh.md)

## Problem

The [remote phone access note](2026-08-14-remote-phone-access.md) made the host reachable from a phone browser. A voice-first mobile experience still needed a real app: iOS Safari has no SpeechRecognition, and React Native has no browser speech APIs at all, so a native app with device ASR/TTS was the only zero-backend route to a voice conversation.

## Decision

Two pieces, zero host-side changes:

- **packages/client/mobile** (`@deepseek-ai/dsh-client-mobile`), a platform-neutral core. `MobileApiClient` subclasses `AbstractApiClient` (`dsh-host-apiproxy/client`), inheriting every protocol invariant (rpcId mint/echo, envelopes, zod value parsing, SSE decoding, heartbeat tolerance) and contributing only the platform aspects: the paired base URL, the manual `dsh_remote` cookie header (RN fetch has no cookie jar), a Hermes-safe rpcId source, the `AbortSignal.timeout`/`any` statics shim, and 401 branding as `UnauthorizedError`, and the WebSocket downlink openers (the network server answers plain GETs on the event paths with 426; the carrier's SSE form exists only for the in-process handler). The socket is injected — RN's WebSocket with header support on device, `ws` in tests and the tunnel e2e. `VoiceChatController` owns session selection (list-reuse or create), seq-watermarked history rebuild plus live event folding, the listen → transcript → auto-send loop, barge-in (stop speech + cancel the turn), and the fence-aware `SpeakQueue` that speaks streamed sentences and never reads code fences aloud; approval/question frames answer through `respond()`.
- **apps/mobile** (`@deepseek-ai/dsh-mobile-app`, private), an Expo SDK 57 shell. Pairing = scan the terminal QR → `pairWithHost` with `redirect: 'manual'` → the `dsh_remote` cookie lands in `expo-secure-store` (keychain). Adapters: `expo-speech-recognition` (device ASR), `expo-speech` (device TTS), `expo/fetch`. Screens: pair (QR or manual URL), chat (markdown messages, inline tool rows, single input bar with an embedded voice key, approval/question cards, settings) — the UI-alignment follow-up is recorded in the [mobile chat UI note](2026-08-16-mobile-chat-ui-web-alignment.md).
- **Repository integration.** The app is a private workspace member: `check-workspace-constraints` whitelists `apps/mobile`, release-family enumeration skips private manifests, knip has an explicit entry, and oxlint ignores the app (it runs its own `tsc --noEmit`). `packages/client/mobile` is an ordinary publishable client package under the per-file 100% coverage gate.
- **Testing.** The package unit suite (106 cases, 100% per-file) plus a keyless e2e (`apps/web/tests/mobile-voice-app.e2e.ts`) that pairs through the fake-cloudflared tunnel, creates a session, subscribes to the mux WebSocket stream, and — in replay mode — drives the full voice round trip reusing the fresh-round-trip fixture and asserts the spoken output contains DONE.

## Alternatives considered

- **PWA voice UI on the existing Web GUI** — rejected: iOS Safari lacks SpeechRecognition, leaving iPhone users a TTS-only product.
- **Server-side ASR (whisper or cloud)** — deferred: model downloads or API keys buy nothing the device engines do not already cover for v1; the recognizer/speaker ports are the seam for it later.
- **Reusing `dsh-client-connection` in React Native** — rejected: its cordis plugin tree, browser bundle semantics, and `window`/`EventSource` assumptions make Metro integration a project of its own, while the apiproxy carrier is already transport-abstracted — subclassing costs one file.
- **SSE downlink via streaming fetch** — rejected for native: the network server serves the event paths as WebSocket-only (plain GETs answer 426; SSE exists only for the in-process carrier), so the browser-style WebSocket opener with a cookie header is the only real-server route.

## Consequences

- The pairing cookie is a device keychain secret; 401 → re-pair, tunnel restart → re-scan (the day-scoped ticket stays valid).
- Android ASR depends on the Google app's speech services; the README states it.
- Reconnects refetch the history tail (the host's `since` resume hook is v1-unimplemented) with watermark dedupe.
- The app's native toolchain sits outside repo-wide gates by design; its logic lives in the fully covered package. `expo-speech-recognition` currently tracks Expo SDK 56 on an SDK 57 app (loose peers) — watch for the SDK 57 release.
- The injected recognizer/speaker/fetch ports are the extension seam for server-side or cloud speech later.