# Agent Note: Phone web foreground resync on the desktop GUI chain

Status: implemented

English | [中文](2026-08-30-phone-web-foreground-resync-gateway-client.zh.md)

## Problem

The desktop GUI pages (the origin web surface, also reached from phones through the tunnel) consume live `session/follow` streams through the Gateway's `RemoteStreamMuxClient`. That client reconnects only off browser `close`/`error` events (0.5–10 s jittered backoff). When a phone backgrounds the page, the OS tears the TCP leg without a close frame, no event fires, and the live stream freezes at the pre-suspension tail until a manual refresh — the same gap the mobile `/m` surface had, on the surface phone visitors actually use.

## Decision

`RemoteStreamMuxClient.resume()` forces one fresh physical socket: a live-looking socket is closed with code 4001 and its logical streams fail with a carrier error naming the resync, which the existing domain supervisors (`RemoteStream`) treat as a retryable loss and answer with an immediate attempt-1 re-open and a fresh snapshot; a hung dial is cut via the cancel candidate so the reconnect loop redials instead of waiting for events a swallowed upgrade never fires. `installForegroundResync` wires the browser foreground transitions (`visibilitychange` → visible, `pageshow` with `persisted`) to it, gated on `isPhoneWeb()` (coarse primary pointer, mobile-UA fallback), and `ClientRemoteService` installs it when the carrier is the browser transport and disposes it with the plugin effect.

## Scope

Desktop browsers see zero behavior change: the installer is inert off a phone, and `resume()` has no other caller. Host and in-process carriers never reach the install site. The `/m` surface keeps its independent recovery.

## Alternatives considered

**Porting the 45 s idle watchdog.** Rejected: it would put every desktop GUI on the recycle-and-resnapshot churn the phone watchdog exists for, far beyond the phone-only scope; the foreground transition is the deterministic signal and needs no timer.

**Reopening streams at the session-controller domain layer.** Rejected: physical liveness belongs to the mux client; the domain layer already owns carrier-retry semantics and only needs the physical layer to fail honestly.

## Consequences

Returning to the foreground on a phone now re-snapshots deterministically, so output produced while the page was suspended appears without a manual refresh, and a hung reconnect dial is cut on the next foreground return instead of lingering forever. If the fresh dial itself fails, the existing domain rule that ends a stream after two consecutive carrier failures applies — a visible failure instead of a silent freeze. Tests cover the resume paths (healthy-socket recycle, hung-dial cut) and the installer gate, targets, and uninstaller.
