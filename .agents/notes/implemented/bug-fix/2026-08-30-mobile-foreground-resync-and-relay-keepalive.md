# Agent Note: Mobile foreground re-sync and relay keepalive

Status: implemented

English | [中文](2026-08-30-mobile-foreground-resync-and-relay-keepalive.zh.md)

## Problem

When a phone backgrounded the `/m` page during a long task — the OS suspends the page and tears or starves its TCP leg without a close frame — returning to the foreground left the chat frozen at the pre-suspension tail until a manual refresh. The only recovery path was the idle watchdog armed before suspension plus a backed-off redial through the tunnel, and once the first follow snapshot had landed, ChatView swallowed every further `down` status, so a silently failing reconnect looked identical to a healthy but idle chat. A manual reload worked because a page navigation rebuilds the whole transport. On the server side the relay kept fanning frames into a departed phone's leg indefinitely: the gateway pings the proxy's upstream connection, whose `ws` client answers pongs at the protocol level, so phone-side death is invisible to the gateway, and the proxy neither forwarded pings nor watched for their absence.

## Decision

`EventsClient.resume()` forces one fresh dial and follow re-open, recycling any existing socket and replacing a pending backed-off dial with an immediate one; the fresh snapshot refolds idempotently over the fold watermark. App attaches the browser's foreground transitions to it: `visibilitychange` to visible and `pageshow` with `persisted` (bfcache restore). ChatView no longer drops non-open transport states: a stall line ("实时连接已断开，正在重连…") renders once the transport has stayed non-open for 3 s, a delay that keeps healthy idle recycles (down → connecting → open within one round trip) from flashing it. The idle watchdog stays as the carrier-switch safety net.

The access proxy now relays the upstream's WebSocket pings to the visitor leg and closes a relayed pair once `PONG_MISS_MAX` (3) consecutive pings go unanswered. This makes the carrier-keepalive claim about the gateway's `websocketHeartbeatIntervalMs` real — the pings actually reach the phone — and bounds how long a dead leg keeps consuming its follow stream. The gateway itself is unchanged: protocol-level pong checking there cannot see the phone behind the proxy.

## Alternatives considered

**Gateway-side pong accounting (terminate clients that miss N pongs).** Rejected: the proxy's `ws` client auto-answers pings on the upstream leg, so the gateway only ever observes the proxy, never the phone; the miss watch belongs at the hop that owns the visitor leg.

**A proxy-owned keepalive timer per relay.** Rejected: the gateway's `websocketHeartbeatIntervalMs` already is the configurable cadence; forwarding it keeps one knob instead of adding a second timer that could drift out of phase.

**An HTTP polling fallback on foreground return.** Rejected: the Typert-wire migration deliberately made the mux socket the only grantor of history and live events; a forced fresh dial is strictly stronger and simpler.

## Consequences

Returning to the foreground now re-snapshots deterministically, so output produced while the page was suspended appears without a manual refresh, and a failing reconnect is visible instead of silent. A departed phone's relay stops within `PONG_MISS_MAX + 1` heartbeat intervals instead of lingering until a kernel timeout. The stale "the multiplexer pings every 15 s" comments in the mobile events client were corrected: the configured default is 30 s (`websocketHeartbeatIntervalMs`), and 45 s of application-frame silence remains the watchdog signal. Tests cover the resume paths (live-socket recycle, pending-backoff cancellation, post-stop no-op), the stall-line settle delay, and the relay's ping forwarding plus unanswered-ping teardown.
