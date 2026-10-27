# Agent Note: The remote proxy strips the forwarding headers a hop in front stamps

Status: implemented

English | [中文](2026-10-27-remote-proxy-strips-hop-headers.zh.md)

## Problem

A paired device reached the Web GUI but a settings section built on the shared host fence answered `{"ok":false,"error":"forbidden: loopback-only"}` with 403 — locally the same route answered 200. Reproduced on the live host: `GET /api/dsh-usage/overview` answered 200 directly on 3080 and 403 through the pairing proxy's loopback port; sending the same request straight to 3080 with `CF-Connecting-IP` or `X-Forwarded-For` also answered 403, which isolated the cause to a header rather than the gate.

`createRemoteProxy` normalized the Host, the browser-trust markers (`origin`, `sec-fetch-*`), and its own `x-dsh-proxied` marker, then relayed every other header. Cloudflare's tunnel stamps `CF-Connecting-IP` (and edges may stamp `X-Forwarded-For`, `X-Real-IP`) on the request the proxy receives, so the relayed request carried a forwarding header. The shared fence in host plugins — `isProxiedRequest` inside `dsh-web-shared/host/loopback.ts`, consumed by `isLoopbackRequest` — reads any forwarding header as "a proxy stood in between" and refuses the loopback branch outright (issue #1906). Routes that gate on loopback only (`dsh-usage`, `dsh-ssh`, `dsh-update`, `session-archive`, task-board) therefore refused every tunneled request regardless of a valid pairing cookie; `/git/api/repos` answered 405 locally and 403 through the proxy in the same run. The pairing-aware routes hid the defect because their second allow path (`remoteWebUiPairing.isPairedDevice`) admitted the request anyway.

## Decision

`FORWARDING_HEADERS` in `packages/remote/remote-access/src/proxy.ts` lists `forwarded`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `x-real-ip`, `true-client-ip`, and `cf-connecting-ip`; the relay drops them beside the Host and browser-trust sets, so the main server sees the same loopback-shaped request the desktop produces, plus `x-dsh-proxied: 1`. The proxy remains the only public trust boundary and the only forwarded signal a downstream consumer may read: a plugin that needs to distinguish tunnel traffic reads the marker, never an edge header. Nothing downstream consumed these headers for a decision — the pairing fallback for rate-limit buckets is a caller-supplied option, not a header read — so no behavior depended on their arrival.

The tunnel edge is not the only producer: any hop in front of the proxy stamps them, and their values describe that hop, not the browser's request to this process.

## Verification

- [`proxy.spec.ts`](../../../../packages/remote/remote-access/tests/proxy.spec.ts) sends `CF-Connecting-IP` and `X-Forwarded-For` through the proxy and asserts the target receives neither, while `x-dsh-proxied` still arrives as `1`.
- Against the live host before the change: direct 3080 → 200, proxy port → 403, direct 3080 with `CF-Connecting-IP` → 403.
- Isolated run of the relay: `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`, `x-forwarded-host`, `forwarded` all arrive `null`; `x-dsh-proxied` arrives `1`.

## Alternatives considered

**Teach each plugin fence to accept a forwarding header when the pairing cookie is valid.** Every plugin outside this repository ships its own generated copy of the fence; the copies would drift, and the fence's rule ("a proxy stood in between, so this is not the desktop") stays true — what is false is that the main server should see the edge's header at all. Rejected.

**Pass a trusted-proxy switch through the proxy.** A per-plugin setting would have to be flipped in five packages to fix one symptom, and the switch exists for operators running their own proxy in front of the host, not for the host's own relay. Rejected.


## Consequences

A paired browser now reaches every loopback-gated plugin route through the tunnel, which is the same reachability the desktop has; the pairing cookie remains the only credential and the proxy the only public boundary. A plugin that wants to know a request arrived through the tunnel reads `x-dsh-proxied`; reading an edge header for that decision is no longer possible, and any future consumer needing the visitor's public address must pass it explicitly rather than inheriting a hop header.
