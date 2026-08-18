# Agent Note: Mobile app layers rebuilt from records after a silent gitignore wipe

Status: implemented

English | [中文](2026-08-17-mobile-rebuilt-from-records.zh.md)

## Problem

A set of mobile-app files the user believed implemented — `PairingScreen.tsx`, `DeviceBindingScreen.tsx`, `src/lib/api.ts`, `src/lib/native-module.ts`, `src/app/_layout.tsx`, `src/state/voice.ts`, android 配置, and `docs/cookbook/adding-a-typert-remote.md` — was reported lost.

Forensics established they never entered git (no commit, stash, or dangling object; no DSH session wrote them). The durable finding was the loss mechanism: the root `.gitignore` bare `lib/` pattern silently ignored `apps/mobile/src/lib/`, and `apps/mobile/.gitignore` ignored `android/` (continuous native generation) — files in either path were invisible to git, so ignored-file cleanup (`git clean -fdX`, `expo prebuild`) deleted them with zero trace.

## Decision

Rebuild the planned mobile structure from committed code in layers, committing at each step, and repair the gitignore hole so the layer is trackable going forward.

- `src/lib/api.ts` owns wire-client assembly (base URL + pairing cookie); `adapters/transport.ts` stays as a compat alias.
- `src/state/voice.ts` owns the `VoiceChatController` lifecycle with subscriber-based snapshot publishing; the `useVoiceController` hook binds the store.
- The expo-router migration routes index/pair/chat/devices through `src/app` with `PairScreen` renamed to `PairingScreen` and pairing state in a route-tree context.
- `src/screens/DeviceBindingScreen.tsx` shows the current host binding with the 30-day auto-unbind rule and offers re-pair or unbind; pairing state live in route-tree context.
- `docs/cookbook/adding-a-typert-remote.md` documents the Remote contribution contract (wire types, `TypertRemoteService` + `@Remote`, the `zod` dependency, `/typert` and `/remote` exports, api/remotes wiring, failure modes).
- `apps/mobile/.gitignore` re-includes `src/lib/`; the ignored `android/` regeneration risk is documented, not lifted.

## Alternatives considered

- **Leaving the files lost and only patching the gitignore** — rejected: the user asked to rebuild the structure, and the layers provide the testability the repo gates expect.
- **Rebuilding only the router UI without the api/voice layers** — rejected: the layers are the point; screens consume a store and a transport factory rather than constructing controllers in component state.
- **Adding a host mux devices RPC to power a multi-device list now** — deferred: the multi-device list is a Web-side feature; the screen manages the current binding meanwhile, and the RPC is a host change outside this note's scope.

## Consequences

Each layer ships node specs (`apps/mobile/tests`), typecheck and `expo export --platform android` pass, and the cookbook pair passes doc-sync's md-wrap, type-check, and site checks (the two pre-existing master gate failures — `verify-export-jsdoc` `RemoteLocaleKey` and the attachment type-equiv drift — are unchanged).

- Files under `apps/mobile/src/lib/` no longer vanish from git; a future `native-module` layer can land there safely.
- The ignored `android/` directory still regenerates on `expo prebuild`; native configuration must move into an expo prebuild plugin or be force-tracked.
- The only glm-5.3 DSH session (`session-b9495644`) did the already-committed P1/P2 mobile and remote-device work, so nothing from recorded sessions was lost.
