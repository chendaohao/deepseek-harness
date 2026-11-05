# Agent Note: Measure before removing loopback WebSocket compression

Status: implemented

English | [中文](2026-11-05-remote-websocket-loopback-compression.zh.md)

## Problem

The remote-access path terminates two WebSocket hops: Gateway to Proxy over the Host-facing hop, then Proxy to the remote client. Both currently negotiate `permessage-deflate` with level `4` and a 1,024-byte relay threshold. A large downlink payload therefore pays Gateway deflate, Proxy inflate, and Proxy deflate even though the first hop carries no public-network bytes.

That Host-facing hop never leaves the machine, whatever the bind. `RemoteAccess` dials `ctx.webServer.host`, which the Web server bound on this host; a dial to one of the machine's own addresses is answered from the kernel's local routing table over the loopback interface, so no interface carries the bytes. Measured on the interface-bound topology: 8 MiB across a socket bound to the host's own interface address moved 8,400,318 bytes on `lo` and under 1.1 KB on the interface itself, the same as an idle 3-second window. There is therefore no deployment in which this hop's compression saves a public-network byte, and removing it is deleting duplicate work rather than trading bandwidth for CPU.

The existing compression decision records that its default and level are unmeasured. Current functional tests prove negotiation and payload equivalence, not CPU, transport latency, or memory. A proposal to remove duplicate work must measure the complete transport path before changing production defaults or treating level `1` as a restoration.

Two constants in the shipped code are inert and currently described as if they acted. `ws` reads `perMessageDeflate.threshold` only when a `*_no_context_takeover` parameter was negotiated, and it always overwrites `windowBits` from the negotiated `*_max_window_bits`, so the relay's `threshold` and both sides' `windowBits` literals change nothing. The Gateway's `MUX_DEFLATE_WINDOW_BITS` is 15, which *is* zlib's default 32 KB window, yet the module comment claims the constant avoids "the 32 KB default" and the constructor comment claims "the default 15-bit window would restart the dictionary mid-frame" — the same file states both readings of the same number.

## Decision

The remote-access Proxy compresses only its remote-facing WebSocket hop. The Host-facing dial to the local Web server declines `permessage-deflate`, so a large downlink payload is inflated once instead of being deflated by the Gateway, inflated by the Proxy, and deflated again for the remote client.

`websocketCompression: 'none' | 'deflate'` keeps its name and its accepted values, and `'deflate'` stays the default, but the value now describes the remote-facing hop alone:

```text
const downstreamCompression = websocketCompression === 'deflate' ? deflateOptions(internals.deflateLevel) : false
new WebSocketServer({ noServer: true, maxPayload: internals.maxPayload, perMessageDeflate: downstreamCompression })
new WebSocket(url, { perMessageDeflate: false })
```

No per-frame change was needed. `ws` sets `compress: false` for every send on a socket that negotiated no extension, so the relay's existing per-frame `compress` argument stays correct on the Host-facing leg.

Gateway direct connections are untouched: browser, Desktop, and Node carriers still negotiate the extension on `/api/remote.mux` with the same default and the same 1,024-character send threshold.

The change has no deployment-visible consequence: the hop it stops compressing cannot leave the machine, so no setting, wire format, or operator action changes. No upgrade guide is required for it.

### Measurement that decided it

The change was gated on a transport diagnostic, not on a byte-count argument. It lives beside its owner as [`remote-stream.perf.ts`](../../../../packages/remote/remote-access/tests/remote-stream.perf.ts), with a fresh-process worker, fixed workload constants, and a compiled integration adapter.

**The adapter is required, not optional.** Neither measured entry is a public export: `RemoteStreamMuxServer` is absent from `@deepseek-ai/dsh-api-gateway`'s entry, and `createRemoteProxy` is absent from `@deepseek-ai/dsh-remote-access`'s entry and from every `exports` subpath. Rather than add a production export that exists only for the measurement, [`remote-stream-adapter.ts`](../../../../packages/remote/remote-access/tests/remote-stream-adapter.ts) re-exports both source modules, the pattern [`benchmarks/terminal-io/session-adapter.ts`](../../../../benchmarks/terminal-io/session-adapter.ts) already uses. The diagnostic therefore resolves source, not built `lib/`, and its report says so instead of claiming published-artifact evidence.

| Field | Decision |
|---|---|
| User operation | Send a large opening, an already-batched answer, and large uplink frames through remote-access; complete only after the client validates every payload |
| Entry path | The production `RemoteStreamMuxServer` and `createRemoteProxy` classes plus a `ws` client on loopback; excludes cloudflared, public-network latency, model generation, Assistant batching, Client fold, and browser paint |
| Workloads | 1.4 MiB repetitive JSON opening, sized from the 1,395 KB Session snapshot recorded beside the Gateway mux deflate constant; a 1,000-delta synthetic answer grouped 50 deltas per frame into 20 frames of about 6.5 KB, so each clears the 1,024-byte relay threshold; 1 MiB and 64 KiB uplink frames; 20 sub-threshold frames as the compression-bypass control |
| Comparisons | A: both hops negotiate the extension, which the relay's test hook restores because the shipped dial declines it; B: the Gateway configured `none` and the Proxy `deflate` with the shipped dial, i.e. the shipped topology. Both arms therefore run the same production relay and differ only in whether the Host-facing hop negotiates |
| Clock and memory | Handshakes and the uplink drain finish before the clock starts; the run stops after the last validated payload; peak and retained RSS recorded separately |
| Metrics | Whole-path process CPU, wall time, P95 frame gap, remote-facing wire bytes, peak and retained RSS |
| Samples | Seven fresh children per variant in the interleaved order `A A B B A A B B A A B B A B`, after one discarded warmup; three full runs recorded |

**The Host-hop arm needs the hook.** The Proxy's dial declines the extension unconditionally, so a Gateway configured to compress has nothing to negotiate with: an arm that only set `gateway: 'deflate'` measured the shipped relay twice, and the first version of this diagnostic did exactly that, which is why its A/B difference could not be reproduced. `internals.hostHopDeflate` restores the extension on the dial for the measurement only; production never sets it.

Process CPU is the right denominator because `process.cpuUsage()` reports `RUSAGE_SELF`, which includes the libuv thread-pool time zlib spends even though that work never occupies the event loop. It is also why one worker cannot split CPU between the two hops: both run in one process.

Wire bytes are counted by inserting a loopback TCP relay between the client and the Proxy and summing the bytes it forwards. `ws` exposes no public counter, and the post-inflate payload length would hide exactly what the compression decision changes.

### Reference measurement

2026-11-05, `linux x64`, Node `v24.16.0`. Run the diagnostic directly:

```sh
node --import tsx/esm packages/remote/remote-access/tests/remote-stream.perf.ts
```

Interval: after every handshake and the uplink drain, until the client validated the last downlink payload — 1 opening frame, 20 answer frames, 20 small frames, and 2 uplink frames the Host consumed. Every sample reported `payloadsMatch: true` and exactly 41 downlink payload frames.

| Metric | A (both hops) | B (Host hop plaintext) | Change |
|---|---|---|---|
| Process CPU, median of 7 (ms) | 60.98 | 45.61 | **−25.20%** |
| Process CPU, every sample (ms) | 56.80, 58.74, 60.98, 90.91, 66.27, 56.52, 70.97 | 40.90, 70.04, 39.37, 44.14, 45.61, 49.26, 48.63 | |
| A/A noise floor (CPU median) | 20.82% | | |
| Remote-facing wire bytes | 122,249 in all 7 samples | 122,249 in all 7 samples | 0% |
| P95 frame gap, median (ms) | 0.94 | 0.90 | −0.04 ms |

Two more full runs of the same schedule, on the same machine, reported −43.23% (A 79.60, B 45.19, noise floor 1.52%) and −25.96% (A 61.59, B 45.60, noise floor 11.56%). The candidate's median stayed within 0.9% across all three runs (45.19–45.61 ms) while the control's ranged 30.5% (60.98–79.60 ms). Only the arm that still deflates is unstable, which is the direction the change predicts; the conservative bound on the effect is the −25.20% run with the widest measured drift.

Verdict: the Host-facing hop's compression did not pay. CPU fell 25% in the conservative run, well past that run's noise floor, the bytes the remote client received were identical, and frame gaps did not regress. Identical wire counts are the expected result, not a measurement artifact: only the Host-facing hop changed, and the client reads the remote-facing hop. The effect is larger than the floor in all three runs but its magnitude is not resolved to better than a quarter on this machine; the direction is, because the candidate's spread is a fraction of the control's.

The CPU interval contains both hops' work in one process, so it does not measure the Gateway alone. That does not weaken the verdict: the change removes work from the path, and the arm that keeps the work is the one whose results move.

### Lane: report-only, not a gate

The diagnostic is not a regression gate, and its location says so. [benchmarks/AGENTS.md](../../../../benchmarks/AGENTS.md) reserves the `.perf.ts` suffix for package-local diagnostics and keeps them out of `test:bench`. It is a plain entry script rather than a Vitest case, matching the existing package-local diagnostics: the parent spawns one fresh child per sample, the child prints one JSON line, and the parent prints the aggregate report.

No Vitest config lists it, so nothing in `ci-*`, `doc-sync`, or `test:bench` collects it. `tsx` is required because both measured classes resolve from source; that cost is paid once per child and stated in the report rather than hidden.

Promoting it to a gate would be a separate change: a calibrated budget in `benchmarks/` with a reviewed reference-machine expectation.

### The level is a test hook, not configuration

`WS_DEFLATE_LEVEL` sets the remote-facing hop's zlib level and lives on `internals` beside the relay bounds, because nothing measured justified a configuration field and no deployment asked for one. The diagnostic sets it before constructing the proxy; production never touches it. Adding `deflateLevel` to `RemoteAccess`'s config would make an untuned constant into a promised surface.

### Inert constants corrected in the same change

`ws` reads `perMessageDeflate.threshold` only when a `*_no_context_takeover` parameter was negotiated, and it always overwrites `windowBits` from the negotiated `*_max_window_bits`. Both literals were therefore documentation that claimed to be configuration. They are now described as what they are, and the relay's own 1,024-byte constant, which does act, is described as the per-frame decision it is.

The Gateway's `MUX_DEFLATE_WINDOW_BITS` comment contradicted itself: it called 15 bits both "the largest zlib offers" (avoiding "the 32 KB default") and the value that avoids restarting the dictionary, while 15 bits *is* `Z_DEFAULT_WINDOWBITS` — 32 KB. The comment now states that the literal records a negotiated value without changing it.

## Consequences

Whole-path CPU for a large downlink fell by a quarter in the conservative measured run, and frame gaps did not regress. The remote client's bytes did not change, because the hop that stopped compressing is not the hop the client reads.

**Interface-bound deployments lose nothing.** A deployment started with a concrete `--host` address also keeps this hop inside the machine: the proxy dials the address the Web server just bound on the same host, and the kernel answers a self-addressed dial from its local table over `lo`. Nothing is exposed that was previously compressed, so such a deployment needs no change and receives no notice.

**Level `1` was measured on the settled topology and rejected.** Comparing it with `4` on the remote-facing hop alone, seven fresh children each, interleaved `B B C C` with `B` as the control:

| Metric | B (level 4) | C (level 1) | Change |
|---|---|---|---|
| Process CPU, median of 7 (ms) | 46.50 | 44.13 | −5.10% |
| B/B noise floor (CPU median) | 0.06% | | |
| Remote-facing wire bytes | 122,249 in all 7 samples | 136,018 in all 7 samples | **+11.26%** |

A second run of the same schedule reported −7.38% against a 20.45% noise floor, so the CPU difference is neither large nor reproducible at this machine's resolution, while the byte cost is exact and unambiguous: level `1` sends 11.26% more bytes to the remote client in every single sample. A cheaper level buys nothing measurable here and taxes the link the compression exists to protect, so `4` stays.

That inconsistency is the honest part of the result. The two runs disagree by more than the effect either one reports, so the measurement rules level `1` out on bytes rather than proving `4` is the CPU optimum. A quieter machine or more samples might find a real CPU saving; it would still have to outbid an 11.26% byte increase on a slow link.

The Gateway's direct-connection level is untouched and needs its own direct-mux evidence before it moves.

**The measurement excludes what it cannot see.** It measures loopback production components, not a phone through a public tunnel, and not the interface-bound topology as a whole: the separate interface-counter measurement above covers that hop and nothing else on it. Assistant batching, Client fold, and browser paint are likewise outside it, so it protects none of their latency.

**Functional behaviour is unchanged and pinned.** Proxy tests prove the upstream dial offers no `Sec-WebSocket-Extensions` while the downstream still negotiates compression, that large and small frames preserve content, order, and binary flags, and that `'none'`, the pending and backlog bounds, Ping/Pong, close, and reconnect behave as before.

The specification's compression suite is green, including the new case that proves the upstream dial offers no extension while the visitor leg still negotiates it. The Gateway suite is green except `keeps a socket alive while compressed frames are written without a Pong`, which fails identically with this change reverted: it is a pre-existing liveness-timing flake, not a regression here.

## Scope and existing decisions

The implemented [permessage-deflate decision](2026-10-18-websocket-permessage-deflate.md) remains active for the configuration vocabulary, direct Gateway negotiation, its own 1,024-character send threshold, context takeover, capacity, and liveness semantics. The relay's 1,024-byte threshold is remote-access's own constant and is owned here.

The implemented [remote phone access decision](../feature/2026-08-14-remote-phone-access.md) remains active for pairing, trust normalization, relay bounds, heartbeat, reconnect, and downstream compression; its statement that the Host-facing hop also negotiates compression is what this change replaced.

## Alternatives considered

**Keep dual-hop compression without measuring.** Rejected because the duplicate work was unpriced. Measuring first was the precondition for touching either hop.

**Disable Gateway compression globally.** Rejected because direct remote clients still need downlink bandwidth savings, and the existing configuration already covers deployments that choose otherwise.

**Restore level `1` as an assumed correction.** Rejected, and the history supports the rejection: the Gateway shipped level `1`, a later commit rewrote it to `4` with no measurement. Comparing the levels needs evidence on the settled topology, not an inference from either end of that history.

**Treat the Host-facing hop as loopback and skip the measurement.** Rejected as an argument, though its conclusion turned out right. The bind address is configurable, so "no bandwidth to save" cannot be read off the default; it had to be measured, and the interface-bound measurement is what showed the hop stays on `lo`. The measurement was required even though the answer was the one the shortcut guessed.

**Add level, threshold, or window configuration.** Deferred because no deployment requirement or measurement justifies new fields. Correcting the inert literals does not make them performance levers.

**Publish the measured classes for the benchmark.** Rejected in favour of the private integration adapter: a production export that exists only for a diagnostic is a surface nobody else consumes.

**Bundle batching, uplink copies, listener dispatch, or HTTP keep-alive changes.** Excluded. Each needs its own profile and owning behavior tests rather than hiding another variable inside the compression comparison.
