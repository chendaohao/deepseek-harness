# Agent Note: Hero preset pick races the first send and loses

Status: implemented

English | [中文](2026-08-16-hero-preset-pick-races-the-first-send.zh.md)

## Problem

Picking a preset on the new-session chip and immediately sending the first message lost the pick. The [seat design](../architecture/2026-08-03-per-session-agent-presets.md) stages the choice and applies it through `agentPresets.select` only when the session list updates; the send path dispatched the prompt in parallel, so the host usually started the turn first and answered `agent-preset-locked` ("session has already started; its agent preset is fixed"). The session then kept the creation-time default. Session logs showed the two orders exactly: a session where the pick predated the message ran the picked preset (with a burst of duplicate `agent-preset/selected` events — every list update during creation fired its own select RPC), and a session where the message was spliced at creation ran the default with no selection recorded.

## Decision

Two fixes, one in each half of the race:

- **The seat's apply is single-flight.** `AgentPresetSeatController.apply()` records the in-flight RPC and coalesces concurrent calls onto it (the session list publishes several updates in one tick, each firing the list-change applier); callers that waited re-check the stage afterward, so a pick staged mid-flight still lands. `runApply` clears the stage only when it is the one it applied — a newer stage survives the older apply's completion or failure.
- **The send path awaits the staged pick.** The seat publishes a root-level `agentPresetSeat` service (a structural `pendingApply()` face read via `ctx.get`, never imported — the plugin boundary stays clean), wired to the seat when the conversation scope mounts and reset to a no-op when it collapses. `ConversationController.send` and `sendSession` await it before `session.prompt`, so a pick made just before the first send composes the session before its first turn instead of racing it. `pendingApply` terminates in every shape: no stage, applied, refused, transport-failed, or unservable (no session — the stage then stays for the list-change applier).

## Alternatives considered

- **Order the create and the prompt on the host** (defer the inbox splice until a preset lands) — rejected: the turn start is the host's admission contract for a prompt; gating every first prompt on a preset round trip would stall deployments that compose no presets, and the client already knows the stage.
- **Apply the pick only from the list-change applier and document the wait** — rejected: the applier fires after session creation, which is exactly the moment the prompt may already be winning the race; only the send path can serialize its own dispatch.
- **Wait on the gate inside the input machine instead of the conversation service** — rejected: `ConversationController.sendSession` is the single prompt choke point both composer and service faces pass through, so one await covers every path (including image admission, which serializes after it).

## Consequences

- A hero-chip pick now composes the session deterministically before the first prompt, including the send-immediately flow; the duplicate select burst is gone (one RPC per stage).
- The gate costs one microtask per send when nothing is staged; with a hung host the select RPC's own timeout rejects first and the prompt proceeds on its own failure path.
- Twelve new regression tests across the seat-store spec, the apply spec, and the service spec; the per-file coverage gate stays green, and the full GUI suite plus the keyless replay e2e pass.
