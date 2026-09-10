# Agent Note: Forward appendHeader through the compression facade

Status: implemented

English | [中文](2026-09-10-compression-facade-append-header.zh.md)

## Problem

`maybeCompressResponse` hands every route handler a hand-rolled stand-in for the response rather than the node one. Whenever the client accepts an encoding — every browser does — that stand-in is what handlers see, so it must carry every response member they use. `appendHeader` was missing, and the `/api` carrier calls it on the first admitted request of each UTC day: `HostConnectionService.requestRejection` appends the refreshed browser-session cookie through the response it was handed.

The call threw `TypeError: res.appendHeader is not a function` inside the route handler, and the carrier's last-resort arm answered HTTP 400 with an empty body. The refresh therefore never reached the browser, the presented cookie stayed day-old, and every later `/api` request of that client repeated the same path: a paired phone lost settings describe, session lists, model catalogs, and agent-preset listing for the rest of the day. A desktop browser recovered at the next `dsh web` start, because the launch-token visit mints a fresh cookie. Nothing on the request side distinguished the two clients — the failing bodies were plain JSON with no `content-encoding`, and the tunnel path served the same call correctly for a cookie issued the same day.

## Decision

The facade implements `appendHeader`: before the deferred commit it merges the appended value, string or array, into the pending header set, so a refresh lands with the handler's other headers at the first body write; after the commit it delegates to the wrapped response, which owns node's sent-header verdict for a late append. Header mutation is now forwarded as `setHeader`, `appendHeader`, and `removeHeader`, which the module doc names alongside the event surface and the writable-state getters.

## Alternatives considered

**Let the `/api` route append through `setHeader`.** Rejected: append semantics belong to the response surface, since a handler may add its own cookies beside the refresh, and third-party routes register through the same carrier — a caller-side workaround would leave the facade's promise, wrapping responses without changing route APIs, broken for them.

**Replace the facade with a proxy that forwards unknown members.** Rejected: the literal documents which members the carrier guarantees, and a catch-all proxy would defer a missing member to the first handler that touches it, which is the failure this note fixes.

## Consequences

A daily cookie refresh no longer depends on whether compression was negotiated, so a paired device keeps working across the UTC boundary instead of failing every `/api` call until it is re-paired. [compress.spec.ts](../../../../packages/host/webserver/tests/compress.spec.ts) pins the served surface — `/refresh` answers 200 with both appended `Set-Cookie` lines on a brotli response — and drives the facade's header surface against a stand-in for the after-commit arm no served response reaches.

The defect class stays open: the stand-in is a structural subset, so a handler calling a member it omits receives the carrier's empty 400, and no operator-visible trace exists because nothing in the shipped Web composition mounts a `ctx.logger` exporter ([the logger's messages fill a ring buffer and stop](../../../../vendor/cordis/src/logger.ts)).
