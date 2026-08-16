# Agent Note: Mobile voice app review fixes

Status: implemented

English | [中文](2026-08-16-mobile-voice-app-review-fixes.zh.md)

## Problem

A review of the mobile voice app surfaced defects the shipped unit suites missed: code-fence bodies with sentence-ending punctuation were read aloud, message images re-downloaded on every snapshot publish with an unbounded retry loop on failure, optimistic user-message dedupe covered only the live path, the stop→start supersession guard captured the wrong generation and left zombie pumps running, the autoSpeak toggle dropped the autoListen hook, model selection highlighted every provider sharing a model id, pairing persistence failures landed as unhandled rejections, and the mux stream had no idle watchdog for silently dead transports.

## Decision

Each defect is fixed where its state lives:

- **`SpeakQueue.feed` returns while an unclosed fence owns the buffer.** `drainFences` strips complete fences; the remaining buffer is fence body only, so sentence-splitting it reads code aloud whenever the body carries sentence-ending punctuation. The guard waits for the closer before splitting again.
- **Message images download once per attachment id per row lifetime.** `MessageImage` anchors its effect to the attachment id (the parent recreates its inline loader closure every render, which previously re-triggered the download on each snapshot publish); a failed load renders a placeholder and stays failed instead of retrying forever through the notice→publish→render loop.
- **`user/message` dedupe runs on both paths.** The pendingTexts echo dedupe no longer checks `live`; a history refetch replays the same echo and would otherwise render the optimistic row twice. `switchSession` clears `pendingTexts` with the rest of the view so an abandoned send cannot swallow a new session's identical-looking message.
- **`MobileConnection` passes the pump's own generation into `scheduleRetry`.** The old guard read `this.generation` at retry time, so a dying pump resuming after `stop() → start()` adopted the fresh generation and kept reconnecting beside the new pump (one extra mux socket per session switch). A superseded pump now exits before publishing or opening a socket.
- **Idle watchdog on the mux stream** (`idleTimeoutMs`, default 45 000, `0` disables): every delivered frame — host heartbeats included — re-arms a per-generation timer whose firing aborts the stream, surfacing as a normal stream end through the existing retry budget. It mirrors the web `ConnectionController` watchdog; the host heartbeat (15 s) keeps live streams from ever reaching it.
- **`setAutoSpeak` rebuilds through the shared `buildSpeakQueue`** so the speaking-complete hook (which also drives autoListen) survives the toggle.
- **Model selection tracks the provider.** `VoiceChatController` publishes `selectedModelProvider` from `session.models.current` and `selectModel`; the settings sheet matches on provider+id so two providers advertising the same model id cannot both render selected.
- **Pairing persistence failures surface.** `PairScreen` awaits the `onPaired` persistence step and shows a dedicated `pairPersistFailed` message instead of rejecting an unobserved promise.

## Alternatives considered

- **Strip the open fence body inside `drainFences`** — rejected: the body must stay buffered until the closer arrives, so the splitter would still need its own guard; the feed-time guard is the single correct choke point.
- **Stabilize only the loader identity (`useCallback`)** — rejected: it removes the per-render refetch but not the failure retry loop; anchoring the effect to the attachment id fixes both.
- **Client liveness from host heartbeats alone** — rejected: heartbeats prove the host is sending, not that the client's receive path is alive; the client-side deadline is the only end-to-end guarantee for sockets the OS never surfaces as closed.
- **Clear pendingTexts on reconnect instead of deduping in history folds** — rejected: clearing on reconnect still duplicates the row the refetch replays, and the dedupe is the same entry the live path already consumes.

## Consequences

- Eight new regression tests (fence punctuation, history-refetch dedupe, switch-session pendingTexts, autoListen after toggle, watchdog fire/keep-alive/disabled, superseded pump); the package keeps its per-file 100% coverage gate and the keyless tunnel e2e still passes in replay mode.
- The watchdog abort surfaces as a normal stream end, so reconnect cost and budget behavior are unchanged; a genuinely dead transport now reconnects instead of hanging on a stale `online`.
- `stop() → start()` semantics are now deterministic: the dying pump exits silently, and only the newest pump owns sockets and status publications.
- Apps/mobile UI copy gained `imageLoadFailed` and `pairPersistFailed` (zh/en); the snapshot vocabulary gained `selectedModelProvider`.
