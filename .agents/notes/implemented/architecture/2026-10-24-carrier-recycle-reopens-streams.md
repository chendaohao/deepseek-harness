# Agent Note: A recycled carrier reopens its stream instead of ending it

Status: implemented

English | [中文](2026-10-24-carrier-recycle-reopens-streams.zh.md)

## Problem

A phone page that leaves the foreground for a while comes back either healthy or permanently dead, with nothing in between. The dead case only clears with a page reload, so the whole shell — which is otherwise still painted and still clickable — stops responding to anything that needs the Host.

Three failures combined to produce it.

**A deliberate socket recycle was reported as a terminal stream failure.** `RemoteStream` treated a `RemoteStreamCarrierError` as retryable only once. Its retry helper read the Connection generation and, when that generation was still current, allowed exactly one reopen before rethrowing the carrier error to the terminal boundary (`terminalStreamFailure`), which turned it into `RemoteError<'gateway/internal'>`. One recycle recovered; the second ended the stream. Two recycles in a row is not an edge case on a phone — it is the ordinary case, because a foreground return and a Network Information change each recycle the shared mux socket. Measured on the tunnel path, a burst of twelve `change` events produced thirteen sockets and 142 logical-stream opens, and the session stream did not survive it.

**The Session had nowhere to go after that.** `Session.failEventStream` set `openState = 'error'` and disposed the stream. Nothing reopened it: `SessionEventStream` was constructed without a `carrierFailed` callback, unlike the control stream, so no supervisor restarted it. The failure was terminal at the object layer, and `ui-chat` rendered `chat.loadError` beside a composer that still accepted typing. The only exit was a reload.

**One foreground return dialed twice.** `installForegroundResync` calls `mux.resume()`, which replaces the socket immediately. Connection then observed that its generation had died and asked Gateway to replace the carrier, so `mux.reconnect()` discarded the socket `resume()` had just dialed. Every foreground return cost two handshakes and two rounds of stream failures for one event.

Nothing in this chain is phone-specific in principle, but only remote pages see it: `isLoopback` gates the browser network watch off for loopback authorities, so a desktop page or a `127.0.0.1` page experiences at most the single-recycle case, which recovered. The tunnel page is where the burst lands, which is why the defect read as "only the phone".

## Decision

Carrier recovery is split by what the failure means, not by how many times it happened.

**While the Connection generation stays current, a carrier failure reopens the stream, indefinitely.** A current generation is evidence that the Host is reachable: the recycle that broke the socket was a foreground resume, a radio transition, or the silence deadline. The caller may already be reading the window, so ending the stream is never the right answer. `RemoteStream` reopens under its own jittered backoff — immediate first reopen, then growth from a 2 s cap to a 10 s ceiling, held there. `packages/api/gateway/src/client/stream-retry.ts` owns that cadence so the gateway does not grow a second timing vocabulary.

**Before a stream's first opening is accepted, the budget is finite.** `preopenRetries` defaults to one reopen. A pending first open has no window for its caller to keep; retrying it forever would turn one call into an unbounded wait whose only exit is the caller's own cancellation. One reopen still fits a recovering radio, because that reopen is immediate.

**Once the generation is gone, nothing changes.** The stream still waits for the next generation Connection publishes under its own backoff, because reopening earlier would only dial a Host the page cannot reach.

**`Session` absorbs the retryable failures that still reach it.** `failEventStream` and a terminally failing `doOpen` schedule one automatic reopen on the same cadence, cancelling it on `dispose()` and on `resync()`. Only codes this client layer owns are absorbed — `gateway/internal`, `gateway/cancelled`, and `session/stream-overflow` name a transport or journal condition whose repair is a fresh opening. A Host-named verdict (`session/not-found` and its peers) is not retried, because reopening would only repeat it.

**Two redundant interrupts were removed from the trigger side.** The Network Information `change` handler debounces 1.5 s: a radio transition reports a burst, and only its last event describes the carrier the page will use. `RemoteStreamMuxClient.reconnect()` consumes a one-shot marker set by its own recycle, so the replacement request that a deliberate recycle provokes is treated as already satisfied; a later request replaces normally. The marker counts a replacement that is still dialing as well as one that has opened — see [a reconnect stops rebuilding what the page already shows](2026-10-26-reconnect-stops-rebuilding-published-state.md) for why the opened-only test never held on a phone.

## Alternatives considered

**Keep the finite budget and rely on the Session-level reopen.** Rejected: it makes a live, recoverable window take a multi-second turn around, and it leaves every other `RemoteStream` consumer — jobs, workspace, terminal, control — dying on the second recycle. The terminal boundary in `RemoteStream` is what was wrong.

**Retry forever including the first opening.** Rejected by the existing contract that a stream which never opened must settle: two consecutive carrier losses before any opening is accepted have always produced `openState = 'error'` after exactly two attempts, and a page that opens a session against an unreachable Host must be able to report that instead of hanging.

**Make the mux own the retry cadence and have streams observe it.** Rejected: streams already span carrier generations, and a domain that owns its resume cursor is the only layer that knows whether reopening is cheap (a continuation) or expensive (a full window). Sharing a cadence would have forced that knowledge upward.

**Debounce inside `ConnectionController.reconnect()` instead of the Network Information handler.** Rejected: `reconnect()` is also the explicit user action ("Reconnect now"), which must never be delayed.

## Consequences

A phone that returns with a dead radio now recovers by itself, and the shell stays interactive while it does. The tested shape of the fix is: three consecutive carrier failures with the generation current and the fourth generation delivering.

The trade-off is that a stream can now retry without bound while the generation reports current. That is bounded in practice by the backoff ceiling and by the caller's lifetime — disposing a stream ends its retries — but a Host that answers the generation handshake and then fails every stream will produce steady reopening traffic at the 10 s ceiling rather than a terminal error. The `preopenRetries` boundary is what keeps that from applying to a call that has nothing to show yet.

The Session-level reopen makes the browser's error state transient. A test that wants to observe `openState === 'error'` must watch the subscription, because an immediately succeeding reopen clears it before a poll would see it. The two recovery tests in `session.client.spec.ts` shortened the delay through `SessionOptions.recoveryDelayMs` for that reason.

The one-shot `recycleSuperseded` marker couples two layers by intent: `RemoteStreamMuxClient` must know that a request from Connection is usually its own recycle's consequence. That coupling is the cost of not dialing twice, and it is deliberately one-shot so a genuine stale-socket replacement still happens. It must count a dial that has not opened yet, because Connection notices the lost generation during the handshake — the [follow-up](2026-10-26-reconnect-stops-rebuilding-published-state.md) measured the two dials and two rebuilding passes that survived the first version of this fix.

## Testing

`packages/api/gateway/tests/control-retry.client.spec.ts` pins the cadence and both sides of the boundary: repeated reopen with the generation current, the finite pre-open budget, the growing delay, and the unchanged wait for a lost generation. `packages/api/session-controller/tests/session.client.spec.ts` pins Session absorption and its refusal to reopen a Host-named failure. `packages/client/connection/tests/client-apply.client.spec.ts` pins the burst debounce and the single interrupt it produces.
