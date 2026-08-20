# Agent Note: history-load resilience over flaky remote links

Status: implemented

English | [中文](2026-08-20-history-load-resilience-remote-links.zh.md)

## Problem

Over the external Cloudflare tunnel (`dsh web --remote`), the phone web GUI fails in two ways that share one root cause:

1. **History never loads.** Opening a session sticks at "载入历史…" (`openState === 'loading'`) — the `session.history` unary either hangs or fails over the flaky remote link.
2. **Live updates stop.** The transport idle watchdog reconnects and resyncs, but the resync rebuilds the window from a history fetch; when that fetch wedges, the cleared window never repopulates, so the "latest messages" never arrive.

The recovery path for live updates — watchdog → reconnect → `resync` → `doOpen` → history — is only as good as the history fetch it depends on. Locally the path is reliable; over the tunnel a single dropped request or a large page on a slow link breaks it, and neither surface recovered:

- The desktop `doOpen` made a single history attempt with no retry, against the fixed 30 s unary budget that the apiproxy client itself documents as "cutting page reads on slow remote links". The intended escape hatch (`deadlineExemptHistory`) was designed but never wired.
- The `/m` surface's hand-rolled `callUnary` (`mobile/rpc.ts`) had **no timeout at all**, so a dropped response hung forever — which also dead-locked the `/m` EventsClient polling fallback (its poll is the same history fetch) and thus live updates on `/m`.
- The `/m` EventsClient idle watchdog only armed after `onopen`, so a socket that never established (a tunnel edge swallowing the upgrade) started no fallback and no reconnect.

## Decision

Make history reads bounded and retryable, on both surfaces:

- **Desktop deadline + retry.** `WebApiClient` opts into `deadlineExemptHistory`; the runtime's `Session.history()` funnel (the single call site for ordinary and addressed reads) supplies `AbortSignal.timeout(60_000)`, so `doOpen`, `loadOlder`, and `repairGap` all carry a generous cap. `doOpen` routes its two pulls through a `historyWithRetry` helper: up to 3 attempts with 1 s/3 s backoff on thrown transport rejections (the apiproxy carrier throws on dropped requests, HTTP status, and timeouts; a folded error result is a business error and is never retried). This also makes a rejected gap-detection re-pull fail-soft (its `if (result.ok)` guard) instead of flipping an already-installed window to `'error'`.
- **`/m` unary timeout.** `callUnary` bounds every call with `AbortSignal.timeout(30_000)` (merged with a caller signal via `AbortSignal.any`), folding a timeout to a `transport` error. This unblocks the EventsClient poll backoff, which previously hung on the same no-timeout history fetch.
- **`/m` connect-time watchdog.** `connectSocket()` arms the idle watchdog immediately (before `onopen`), so a socket that never establishes still recycles into polling + reconnect after `idleTimeoutMs`.

The existing idle-watchdog/heartbeat decision ([2026-08-18-mobile-web-refresh-after-completion](2026-08-18-mobile-web-refresh-after-completion.md)) remains the transport-liveness mechanism; this note makes its recovery path survive a flaky link.

## Verification

Unit tests cover the three behaviors: `doOpen` retries a transient history throw then opens (and exhausts retries into `'error'`, never retrying a business error), a rejected gap-detection re-pull keeps the installed window open, `/m` `callUnary` folds a never-resolving fetch into a `transport` error after the timeout, and the `/m` EventsClient watchdog fires for a socket that never opens and starts polling + reconnect. `pnpm run test` (connection/runtime/ui-remote), `pnpm run typecheck`, and the client bundle builds pass.

## Alternatives considered

**Add a desktop history-polling fallback** (per-session staleness poll when mux frames go quiet). Rejected for scope: the reported symptoms trace to history reads failing/hanging, not to a mux-stalled-but-host-alive transport, so the bounded/retryable history path fixes them. The residual gap — desktop live updates when the mux stream stalls while the host stream keeps the watchdog alive — remains a documented known limitation (the desktop has no poll fallback; `/m` does).

## Consequences

A single dropped history request no longer wedges the web GUI at "载入历史…"; after a reconnect the watchdog's resync survives transient failures and repopulates the window. `/m` unary calls fold to errors instead of hanging, and its polling fallback can actually back off and retry. Business errors are never retried, so a genuinely missing session still surfaces immediately. Timeouts are transport constants (`HISTORY_DEADLINE_MS`, `DEFAULT_RPC_TIMEOUT_MS`, `HISTORY_RETRY_*`), consistent with existing tunables like `PAGE_MESSAGES`.
