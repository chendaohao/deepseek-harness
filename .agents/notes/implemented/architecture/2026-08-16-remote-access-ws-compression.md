# Agent Note: Remote-access tunnel-leg WebSocket compression — permessage-deflate on the downstream leg

Status: implemented

English | [中文](2026-08-16-remote-access-ws-compression.zh.md)

## Problem

The remote-access proxy relays the Web GUI's two event-stream WebSockets over a public quick tunnel; every byte of those streams crosses the tunnel on the proxy's downstream (tunnel-facing) leg. That leg never negotiated compression: neither the relay's `WebSocketServer` nor its upstream client set `perMessageDeflate`, and the downlink sockets did not either. Event frames are JSON text with high redundancy, and remote use is dominated by mobile data links, so this was the largest removable bandwidth cost of remote access.

## Decision

`createRemoteProxy` enables permessage-deflate on the downstream leg when the new `dsh-remote-access` config `wsCompression` is on (default `true`), using the `ws` library's default negotiation parameters (1 KiB compression threshold, `concurrencyLimit` 10). The loopback leg stays plaintext — the upstream client passes `perMessageDeflate: false` — because zlib on a loopback hop buys zero bandwidth and costs CPU on both sides. Compression is negotiated per connection during the WebSocket handshake, so clients that do not offer the extension (legacy browsers, native stacks without support) transparently negotiate none, and existing open connections are never affected: the change reaches only handshakes started after the next `dsh web` restart.

## Alternatives considered

- **Compress both legs** — rejected: the loopback hop gains no bandwidth; double zlib pressure on host and client for nothing.
- **Compress at the downlink source instead of the relay** — rejected: the downlink sockets serve loopback traffic whose compression would never cross the tunnel; the relay is the only hop whose frames traverse it, and enabling there covers every consumer of the proxy.
- **Default `wsCompression` off** — rejected: every current browser and the `ws` client offer the extension, the bandwidth saving on mobile links is the point of remote access, and the config remains as the escape hatch for CPU-constrained hosts.

## Consequences

- Tunnel-leg WebSocket traffic now compresses; the proxy test measures a 68 KiB repetitive JSON payload crossing the downstream leg at ~250 bytes (~270x) while the echo target still receives the full plaintext.
- Per-message zlib cost (≥ 1 KiB messages only, per the `ws` threshold) lands on the phone and the host; `concurrencyLimit` caps simultaneous compressors.
- Existing connections are untouched (handshake-scoped negotiation); after the next restart new connections negotiate automatically, and no re-pairing is needed — device bindings and cookies are transport-independent, per the [remote-device-bindings note](../feature/2026-08-15-remote-device-bindings.md).
- `wsCompression: false` restores the prior uncompressed behavior.
- Coverage: `proxy.spec.ts` asserts negotiation on/off and, through a transparent byte-counting relay, that compressed wire bytes stay below a quarter of the uncompressed round trip with identical payload integrity.
