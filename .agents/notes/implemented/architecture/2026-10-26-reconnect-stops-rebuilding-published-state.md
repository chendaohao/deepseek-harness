# Agent Note: A reconnect stops rebuilding what the page already shows

Status: implemented

English | [中文](2026-10-26-reconnect-stops-rebuilding-published-state.zh.md)

## Problem

After [a recycled carrier reopens its stream](2026-10-24-carrier-recycle-reopens-streams.md) landed, a phone page recovered from a background trip with its content intact but its interface visibly rebuilding twice on the way back: the pinned section collapsed and regrew, and the Session list's titles blanked before returning. Two independent defects produced that, and the first one also meant the earlier fix's own headline claim — one foreground return, one dial — was not holding.

The probe timeline (`~/.dsh/logs/reconnect-probe.log`, phone rows after the fix deployed) shows the dial:

```
22:20:22.886 ws#45 construct   22:20:22.956 ws#45 close 1006 +70ms
22:20:23.202 ws#46 construct   22:20:26.045 ws#46 open +2844ms
```

Close code `1006` arriving 70–105 ms after construction is a client-side `close()` of a socket that never completed its handshake, not a network failure. Only `cancelCandidate` closes a connecting socket, and only `reconnect()` and `resume()` call it.

**The one-shot recycle marker never matched.** `resume()` clears `socket` and dials a replacement; the replacement's `socket` field is assigned only in the driver's `opened` callback. Meanwhile the `$events` stream dies, Connection's generation goes with it, and its retry calls `mux.reconnect()`. That path tested `recycleSuperseded && socket !== undefined`, and during the handshake `socket` is always undefined — so the marker survived unconsumed and the request fell through to cancel the dial `resume()` had just started. One foreground return still cost two dials and two rounds of stream failures.

**The projection state was rebuilt twice from two unrelated triggers.** The control stream restarts itself on carrier loss (`packages/api/session-controller/src/client/transport.ts`), so its fresh baseline reseeded every projection. Independently, the new generation's `handleConnected()` cleared every projection store and re-pulled the list. In between, `pinned` read `undefined`, and the pinned section is derived from that key — which is why the visible artifact was a section collapsing and regrowing rather than a quiet value swap.

The two can also arrive in either order, because the control restart does not wait for the generation to die. When the baseline lands first the sequence is seed → clear → pull, so the blank window is longer than either path alone.

## Decision

**A replacement counts as dialed whether or not it has opened.** `reconnect()` treats the marker as satisfied when a socket exists *or* a dial is in flight. `maintain()` is already idempotent on both conditions, so the early return cannot leave the carrier absent. The marker stays one-shot: the request it absorbs is the consequence of the recycle, and the next request is a genuinely stale socket.

**Generation change retires watermarks; it does not delete values.** `ProjectionValueStore` tags every row with the generation that wrote it, and `beginGeneration()` advances the tag without touching the map. Reads keep returning the previous generation's values, so nothing blanks on screen; the first write of the new generation replaces them. Seqs become comparable only within one generation, which is what makes a new baseline able to land over a retired row carrying a higher seq — the case the deletion was originally introduced for.

**A cached block still covers its whole key set.** A retired cached row that the new generation's block omits is dropped with that block, because the block is the complete current answer and an omitted key is one the source no longer reports. Without this, a key the Host had stopped sending would survive every reconnect.

`clear()` remains, with a narrower meaning: the Host reports this Session holds nothing, which is an absence rather than a generation change.

## Alternatives considered

**Lazy deletion — empty the map but keep serving the old values.** Rejected: it is the same defect with a smaller window. The readers that matter (the list rebuild, `useProjection` faces) are notified by the same microtask, so an emptied map that still resolves reads would need a second "pending" state distinguishing absent from retired. The generation tag carries that distinction in one integer.

**Make `handleConnected` wait for the control baseline, then clear and seed in one tick.** Rejected: it fixes the double-rebuild for Sessions the baseline carries and leaves it for every cold Session, and it still has to reason about which of two writers arrives first. Retiring by marker removes the ordering question instead of answering it.

**Drop the `clear()` path entirely and rely on generation retirement.** Rejected: `refreshProjections` uses `clear()` to express a Host answer of `null` — the Session genuinely holds no projections. That is not a generation change and must keep blanking.

**Keep the control stream's self-restart and remove `handleConnected`'s re-pull.** Rejected: the restart repairs control state only; the list still has to be re-pulled for a new generation, and list rows come from a different RPC.

## Consequences

A phone returning from the background dials once per recycle and renders one state: values it was already showing stay until the Host answers for the same key, then replace in place. Measured on the same probe, an `installWindow`-style full replacement of the Session row block no longer follows a mere generation change.

The trade-off is that `ProjectionValueStore` now reports a value whose watermark is absent — `get()` returns the retired value while `seqOf()` returns `undefined` for it. That asymmetry is deliberate and load-bearing: callers using `seqOf()` as a watermark must not compare a previous generation's seq against a current one, and `Session.retireAdmittedSubmission` reads exactly that way. A future reader that assumes `get()` and `seqOf()` are consistently present would be wrong.

Retired rows also persist until written, so a Session that reconnects and is then never refreshed for a key keeps the previous value indefinitely. That is the intended behavior for display, and every path that owns a key writes it on the next generation.

## Testing

`packages/api/gateway/tests/gateway.client.spec.ts` pins both sides of the marker: a reconnect during the replacement's handshake cancels nothing, and the request after the marker is consumed replaces normally. The first case fails against the previous `socket !== undefined` test.

`packages/api/session-controller/tests/projection-store.client.spec.ts` pins retirement: a value survives `beginGeneration()`, its watermark does not, a lower-seq baseline of the new generation still lands, an omitting cut retires it, and a same-generation stale cut still loses to a newer frame. `tests/inbox-projection.client.spec.ts` and `tests/manager.client.spec.ts` carry the two end-to-end expectations that named the old behavior — a cold Inbox and a title that used to blank across a reconnection — and now assert the value stays published until replaced.
