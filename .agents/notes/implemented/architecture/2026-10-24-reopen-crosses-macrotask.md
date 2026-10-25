# Agent Note: A reopen must cross a macrotask boundary

Status: implemented

English | [中文](2026-10-24-reopen-crosses-macrotask.zh.md)

## Problem

[The carrier-recycle fix](2026-10-24-carrier-recycle-reopens-streams.md) made a current-generation carrier failure reopen a stream indefinitely, and that closed the "page never reconnects" defect. It also introduced a new one that only appears on a slow link: a phone returning from the background ran for a few dozen milliseconds and then stopped executing script entirely. The interface stayed visible and accepted touches, but nothing responded, and only killing the browser recovered it.

Three properties of the reopen loop combined to produce it.

**The first reopen resolved on the next microtask.** `streamRetryDelay(1)` returned `0`, and `defaultStreamRetryTimer` resolves a zero delay without involving the timer queue at all. Against a peer that failed as fast as it reopened, the loop therefore ran entirely inside the microtask queue.

**A revision change reset the attempt count.** `read()` cleared `attempt` whenever `observedRevision !== this.revision`, so the backoff could never climb past its first tier. Any restart returned the stream to the immediate tier, which is the state that resolves without a timer.

**`carrierFailed` can restart the stream it was just told died.** `createSessionControlStream` does exactly that, because a control baseline must re-establish Host state after a carrier loss rather than wait for a generation a foreground resync never publishes. So one carrier failure produced a new revision from inside the failure handler, the revision check sent the loop straight back to the top, and the cycle never left the task it started in.

The loop is unbounded in wall-clock terms but synchronous in effect: with no timer and no other macrotask-triggered await, the page's `setInterval` callbacks are never scheduled. Measured on a phone over the tunnel, `revision` advanced from 35 to 114 in 21 ms while `attempt` stayed at 0 and no retry delay was ever requested. The page's own 5 s heartbeat stopped at the same instant.

The defect needs a fast-failing peer to be visible. On a healthy link the reopen succeeds and the loop exits. On a 3G tunnel where the socket handshake takes seconds, the peer fails immediately and the cycle repeats forever.

## Decision

**A reopen never resolves on the next microtask.** `streamRetryDelay` returns at least `StreamRetryConfig.minMs` (200 ms) for every attempt, including the first. The floor was previously a jitter minimum; it is now a structural guarantee that each reopen crosses a macrotask boundary, which makes microtask starvation impossible regardless of how fast the peer fails.

**A revision change never resets the attempt count.** Another generation starting is not evidence that the carrier recovered. Only an accepted opening proves that, and `accept()` already resets the count at exactly that point.

**A superseded generation waits out one cadence step before the loop serves its replacement.** `awaitSupersede` uses the same `streamRetryDelay` sequence, so a caller cannot distinguish a supersede from a carrier reopen. The wait deliberately ignores the generation's own abort signal: that signal is the one the restart aborted, and its abort is what brought the loop here.

## Verification

Three regression tests in `packages/api/gateway/tests/control-retry.client.spec.ts`, each verified in both directions — passing on the fix, failing when that specific change is reverted:

| Test | Reverted change | Failure |
| --- | --- | --- |
| `never reopens without a delay` | `streamRetryDelay` floor | `expected 0 to be greater than or equal to 200` |
| `does not reset the backoff when a restart replaces the generation` | revision reset | `expected 1262 to be greater than or equal to 1559` |
| `waits before serving a generation that a carrier callback restarted` | supersede wait | `expected [] to have a length of 3` |

The third test asserts on the timer call order rather than on wall-clock starvation: an earlier version measured a `setInterval` counter and passed against the broken code, because a test's fake timer yields control in ways a real page does not. What makes the defect observable is whether the timer is consulted at all, so that is what the test now checks.

End-to-end confirmation came from a phone against the tunnel, not from the suite: the `revision` count for the self-restarting control stream fell from 114 to 4 across a background/foreground cycle, `attempt` reached 2, and `delay=200` appeared for the first time.

## Consequences

Recovery after a foreground return now takes at least 200 ms longer than it did. That is the price of the guarantee; on the phone path it is invisible beside the socket handshake.

`awaitSupersede` runs on a path that is hard to reach in tests without control of the microtask queue, which is why the note records the manual evidence alongside the unit coverage rather than claiming the suite covers it.
