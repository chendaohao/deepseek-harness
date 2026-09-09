# Agent Note: Decoding compressed RPC request bodies at the /api JSON parse point

Status: implemented

English | [中文](2026-09-09-request-content-encoding-decode.zh.md)

## Problem

A paired phone reported `transport failure for /api/llm/listProviders: HTTP 400` on the Models settings page and could not load any workspace's sessions after the 0.1.5-alpha.1 merge — while every desktop client and every curl replay of the same call through the same public tunnel returned 200. The server log showed nothing: the failing path never logs.

The difference was the request body. Mobile browsers on metered networks compress uploads (`content-encoding: gzip` on POST bodies — Quark's mobile browser does this), and WHATWG `fetch` never decodes request bodies. The `/api` RPC bridge parsed `request.json()` off the raw bytes, so a gzipped body failed JSON parsing and fell into the 400 `body is not JSON` arm of `rpc-host.ts` — a no-log rejection, which is why the log stayed clean while the phone got HTTP 400 everywhere.

The gap predates the merge (upstream master has the same hole); the merge only made it visible by invalidating the phone's cached client state and prompting a fresh login from a cellular browser.

## Decision

**The JSON parse point owns request-body decoding.** `rpcFetchHandler` in `packages/client/connection/src/rpc-host.ts` reads the buffered body, then decodes it per `content-encoding` before `JSON.parse`:

| `content-encoding` | behavior |
| --- | --- |
| absent / empty / `identity` | unchanged passthrough |
| `gzip` / `x-gzip` | `gunzipSync` |
| `deflate` | `unzipSync` (sniffs the zlib wrapper, so the zlib-wrapped spelling and the raw deflate stream some clients emit both decode) |
| `br` | `brotliDecompressSync` — symmetric with the response compression the webserver already negotiates |
| anything else | 415 with a message naming the encoding |

- **Sync codecs, deliberately.** The HTTP bridge already buffers the whole body before handing the fetch handler a `Request` (buffered mode), so the bytes are resident and a codec failure is just a 400. A streaming pipeline would add backpressure machinery for zero benefit on this path.
- **64 MiB decompressed-size cap** (`MAX_DECOMPRESSED_BODY_BYTES`), answered 413 — a decompression bomb's expansion is bounded below the bridge's 300 MiB raw cap, which applies to the compressed bytes it buffers. Uncompressed bodies do not hit this limit; they are the bridge cap's concern, unchanged.
- **The remote-access proxy stays a transparent relay** — it neither decodes nor strips `content-encoding` on the way through; decoding happens once, at the parse point. WebSocket mux streams are frame-protocol based and untouched.

## Alternatives considered

- **Decode in the HTTP bridge (`http-bridge.ts`)** — rejected: the bridge is carrier plumbing shared with exact Fetch routes (file upload, log download) that own their raw-body semantics; deciding encoding policy per route belongs to the route, and the JSON parse point is where this route's contract lives.
- **Decode in the remote-access proxy** — rejected: it would duplicate the decode for every hop the response path does not symmetrically re-encode, and a future direct (desktop, non-tunneled) request with an encoded body would still 400.
- **Tell users to disable upload compression** — rejected: the browser controls this header, not the user.

## Consequences

- Compressed uploads work end to end: `llm/listProviders`, `session/list`, and every other buffered `/api` POST decode before parsing.
- Unknown encodings fail loud with 415 instead of a misleading 400, and the failure names the encoding.
- Upstream carries the same gap; the note exists so the fork patch and its rationale survive until an upstream PR can absorb it.

## Verification

`packages/client/connection/tests/rpc-body-decode.host.spec.ts` drives the mounted `HostConnectionService` shared handler through the full composition (fence stub, shared-handler dispatch, interceptor receipt): gzip, both deflate spellings, br, `x-gzip`, uncompressed and `identity` passthrough, unknown encoding → 415, corrupt compressed bytes → 400, 80 MiB expansion → 413, and a 65 MiB uncompressed body unaffected by the decode cap. The full connection suite (16 files, 176 tests) passes unchanged. Real-path verification: a gzip-body curl through the public tunnel URL returned 400 before the fix and 200 after the service restart.
