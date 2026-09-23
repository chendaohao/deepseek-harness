# Agent Note: Web transport optimization for mobile browsers — compression, caching, WS deflate, preload, and service worker

Status: implemented

English | [中文](2026-08-20-web-transport-optimization.zh.md)

## Problem

The dsh web GUI's transport chain (node:http carrier, SPA dist server, plugin bundle route, WebSocket downlinks) shipped without any transfer optimization. A first page load transfers ~5.8 MB of uncompressed JavaScript and CSS over HTTP/1.1 (shell 1.16 MB + 53 plugin bundles 4.58 MB), every reload re-fetches all of it (`no-cache` on bundles, no cache headers on hashed shell assets, no validators), and the two event-stream WebSockets carry uncompressed JSON text. On a phone's cellular link this is seconds of unnecessary latency and repeated daily data cost.

## Decision

The webserver carrier gains a per-request compression pass (`packages/host/webserver/src/compress.ts`): brotli-preferred, gzip fallback, negotiated from `Accept-Encoding`; only compressible MIME types with a body-bearing status and a known size over the 1 KiB threshold compress; SSE (`text/event-stream`) always passes through byte-identical with zero added latency. A compressed response drops `content-length` (chunked framing) and adds `Vary: accept-encoding`. Config: `compression: 'auto' | 'br' | 'gzip' | 'none'`, `compressionThresholdBytes`, and `keepAliveTimeoutMs` (default 30 s for slow mobile links). The web-app bundle wires `compression: 'auto'` with a `DSH_WEB_COMPRESSION` env escape.

The SPA dist server (`frontend-static`) serves Vite content-addressed assets (`assets/*`, fonts, langs) with `Cache-Control: public, max-age=31536000, immutable`; non-hashed static files get `public, max-age=3600, must-revalidate` — except the service-worker script, which is `no-cache` so deployed workers take over on the next visit; every index response stays `no-cache` with a strong ETag and answers 304 on `If-None-Match` — the boot manifest's index-tap injection keeps changing with the plugin set, so the document revalidates while the payload re-download stops.

Plugin bundles (`/plugins/<id>/client.js?rev=…`) are content-hashed per rev, so the modules route serves them `immutable`; a rebuilt bundle gets a new rev URL and the HMR chain swaps the URL, so stale caches can never serve torn content.

The connection plugin's WebSocket downlinks negotiate `perMessageDeflate` (default on; configurable off) — frame payloads are JSON text and compress 60-80% on chat-heavy streams.

The boot-manifest injection (`client-modules`) adds `<link rel=preload as=script>` hints for the stage-one `immediately` rows, collapsing the HTTP/1.1 request waterfall by starting those transfers during HTML parsing (bootstrap rows already scripted are not double-hinted).

A service worker (`apps/web/public/sw.js`, registered from `main.ts` on http(s) origins only — Electron file:// skips it, and `updateViaCache: 'none'` keeps update checks off the HTTP cache) makes the shell offline-capable: network-first for navigation (the manifest must stay fresh), cache-first for `/assets/*` and rev-hashed `/plugins/*`, and never caches `/api/*` or the events stream.

## Alternatives considered

**A shared compression middleware package** — a new `dsh-http-util` compress module could serve both the webserver and the remote-access proxy. The proxy already handles pairing and relay with its own semantics, and the webserver's facade approach keeps compression invisible to route handlers; a shared package adds coupling without a current consumer.

**HTTP/2 in the carrier** — replacing `node:http` with `node:http2` would multiplex the 53-bundle waterfall natively, but `http2` request/response objects are not `IncomingMessage`/`ServerResponse` and every route handler, the fetch bridge, and the upgrade machinery would need rework. The preload hints cover the first-load waterfall; h2 remains a deployment-layer option (front a reverse proxy) documented in the README.

**Compressing SSE** — brotli over a text/event-stream adds latency (the codec buffers) and breaks byte-level framing for proxies; the real-time path stays identity.

**ETag on plugin bundles** — the rev query already is the validator; immutable caching makes revalidation moot.

## Consequences

- First load drops from ~5.8 MB to roughly 1.5-1.8 MB on modern browsers (brotli); repeat loads cost only the index revalidation round-trip (~100 bytes) until a plugin set or shell changes.
- Compression costs a little CPU per request (brotli at default quality is fast on modern Node); the 1 KiB threshold and the MIME/status gates keep tiny and binary responses off the codec path. `compression: 'none'` remains for reverse proxies that compress themselves.
- The service worker adds a first-visit install step and cache-management surface; failures degrade to the plain network path (registration failures only warn).
- The webserver facade defers header commitment until the first body write; handlers that call `flushHeaders()` before writing a body pin the response to identity (headers are already on the wire) — documented on the function. Its `statusCode` accessor and `writeHead` both feed that deferred commit, so a handler that refuses by assigning `statusCode` keeps its status instead of being served as 200.
- Keep-alive rises from 5 s to 30 s by default: fewer re-handshakes on flaky mobile links, at the cost of more idle sockets on the server; deployments behind an aggressive proxy can lower `keepAliveTimeoutMs`.

## Testing

- `packages/host/webserver/tests/compress.spec.ts` (real Loader composition, raw-socket reads): brotli/gzip negotiation, threshold, MIME and SSE gating, content-length removal, Vary, identity paths, and a status a handler assigned through `statusCode`.
- `frontend-static` composition spec covers the cache headers and 304 on the existing fixtures; `client-modules` node-half spec asserts the immutable plugin-bundle headers and the preload hints.
- The webserver and connection downlink suites stay green unchanged (compression is transparent to routes; deflate is negotiated per connection).
