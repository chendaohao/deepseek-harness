# Agent Note: mobile web live-update after task completion

Status: implemented

English | [中文](2026-08-18-mobile-web-refresh-after-completion.zh.md)

## Problem

After a task completes, the host-side Stop hook pushes the Feishu notification, but the mobile web (the remote Web GUI on a phone, and the `/m` surface) does not update: the final session events never arrive, and the page stays stale until a manual refresh. The desktop and mobile clients both miss the same failure mode: a phone switching mobile data <-> WiFi (or a backgrounded browser tab) tears the WebSocket TCP leg silently — no close frame reaches the browser — so `onerror`/`onclose` never fire, the reconnect machine never runs, and no resync happens.

The remote-access design ([2026-08-14-remote-phone-access](../feature/2026-08-14-remote-phone-access.md)) already documents the heartbeat + idle watchdog pair covering this exact case in `packages/client/connection`, but the working branch was missing it: the host `WebSocketDownlinks` never emitted `stream/heartbeat`, the client `ConnectionController` had no `idleTimeoutMs` watchdog and no `recycle()`, and no network-change listeners were attached.

## Decision

Port the connection-package heartbeat/watchdog implementation from `dev` (the 2026-08-15 native mobile voice app) into the working branch, and extend the same watchdog to the `/m` mobile surface's own `EventsClient`:

- Host `WebSocketDownlinks` sends a `stream/heartbeat` frame on each quiet stream every `heartbeatIntervalMs` (host plugin Config, default 15 000 ms, 0 disables), which also keeps tunnel edges from reaping idle sockets.
- Client `ConnectionController` runs a per-generation idle watchdog (`idleTimeoutMs`, default 45 000 ms = three heartbeat intervals, 0 disables; loopback pages default it off because their sockets never cross a network boundary). Any frame resets the timer; a firing watchdog aborts the generation and the existing backoff machine reconnects and resyncs.
- The browser `online` event and the Network Information API's `change` event recycle the generation immediately as the fast path (Safari fires neither and falls back on the watchdog).
- The mobile `/m` `EventsClient` gains the same idle watchdog (`idleTimeoutMs`, default 45 000 ms, 0 disables): every delivered frame (host heartbeats included) resets it, so a silently dead transport recycles into the existing polling fallback + reconnect path.

The runtime `SessionManager` already drops `stream/heartbeat` frames on the mux stream and ignores unknown host frames, so the new frames never reach session state or a model request.

## Verification

Connection-package tests cover heartbeat emission (quiet streams, busy streams, disabled interval, failed send), the idle watchdog (silent recycle, frame/heartbeat resets, `recycle()`, disabled), and the browser `online` fast path with listener disposal. Mobile-wire tests cover the `/m` watchdog (silent recycle into polling, frames keep polling dormant, disabled). `pnpm run test:gui` passes (275 files, 3830 tests) and `tsc -b tsconfig.client.json` is clean.

## Alternatives considered

**Rely on browser close/error events.** Rejected: a mobile-data <-> WiFi switch tears the TCP leg without a close frame, which is exactly the silent-death case the watchdog exists for.

**Poll the session list from the mobile page.** Rejected: the `/m` surface already has a history-polling fallback that only engages after socket failure is detected; the watchdog is what makes a silent death detectable so the fallback can start.

## Consequences

A phone network switch no longer wedges the web page: the host heartbeat plus the client idle watchdog detect the silently dead transport (≈45 s worst case) and the network-change fast path usually reconnects in well under a second, all through the existing reconnect/resync machine — so the task-completion events arrive live and the page updates without a manual refresh. Heartbeat frames are ignored by the business layer (never logged, never model-visible). Loopback pages default the watchdog off, so local behavior is unchanged; remote (tunnel) and LAN pages get the default deadline. The `/m` surface's polling fallback starts as soon as its watchdog detects the dead socket.
