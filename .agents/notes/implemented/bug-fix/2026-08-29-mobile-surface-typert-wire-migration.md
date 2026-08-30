# Agent Note: Mobile surface on the Typert wire and the remote-stream mux

Status: implemented

English | [中文](2026-08-29-mobile-surface-typert-wire-migration.zh.md)

## Problem

Upstream dsh 0.1.2-alpha.1 removed the ApiProxy package, the only backend of the dotted `/api/session.list` wire. The `/m` mobile surface still spoke that protocol, so every unary call returned 404 and the phone web showed an empty workspace and session list after the merge. The new host also has no unary roster read, no per-session model directory, and no HTTP history path: `session/page` requires a `throughSeq` cursor that only a `session/follow` snapshot grants, and live events ride `session/follow` streams on the `/api/remote.mux` multiplexer.

## Decision

The mobile surface migrates to the current wire. `rpc.ts` posts the client-request envelope to slash endpoints with a `{ args }` payload keyed by descriptor wire names (`_request` for `session/list`, `request` for the rest); the response envelope is unchanged. `session/page` records convert to fold events through `@deepseek-ai/dsh-session/chunk-rows`, expanding packed `chunkrow/*` runs back into `assistant/chunk` deltas. The workspace roster resolves from one `workspace/follow` stream on a short-lived socket: open, baseline, cancel. Subagent-origin rows stay off the session list, matching the desktop tree.

`events.ts` runs one `session/follow` stream on a persistent `/api/remote.mux` socket for the observed session. The opening snapshot feeds the chat tail through a new `onSnapshot` face (records, cursor, hasMore, projection baseline) and appended entries fan out as `session/event` frames exactly as before; switching the observed session sends `cancel` + `open` on the live socket. The old HTTP polling fallback is gone: pages are bounded above by the snapshot cursor, so a socket-less client can read neither history nor live events — the multiplexer socket is load-bearing, and the reconnect backoff plus the idle watchdog (recycled, since the browser cannot observe the server's WebSocket pings) are the failure surface, reported through a new `onStatus` face.

`ChatView` takes its tail, page cursor, and current model (the `modelSelection` projection's `next ?? lastUsed`) from the snapshot, pages older history through `session/page` below the cursor, and reads the model directory from the deployment-wide `session/modelCatalog`; `session/prompt` mints the now-required client `requestId`.

## Alternatives considered

**A dotted-protocol shim in front of the gateway.** Rejected: it would reintroduce the removed ApiProxy seam as permanent local surface, contradicting the merge's direction, and still leave the roster and history-cursor gaps unsolved.

**A roster snapshot endpoint added to the workspace capability.** Rejected as a host-side change serving one consumer; the baseline-then-cancel pattern over the existing stream keeps the capability unchanged.

## Consequences

The mobile surface and the desktop client share one wire vocabulary, so future host changes touch one migration instead of two. A tunnel that does not forward WebSocket upgrades now breaks chat history and the workspace roster where it previously only broke live streaming — visible as the roster error state and the chat's "实时连接不可用" banner. The idle watchdog recycles an idle socket every 45 s; reconnect re-snapshots and re-folds idempotently through the seq watermark. Tests cover the envelope and args shapes, mux frame parsing, follow open/switch/recycle paths, snapshot-tail folding, cursor paging, and the projection-derived model chip.
