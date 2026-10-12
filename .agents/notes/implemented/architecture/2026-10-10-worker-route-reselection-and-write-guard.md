# Agent Note: Worker-route children re-resolve their LLM route per request

Status: implemented

English | [中文](2026-10-10-worker-route-reselection-and-write-guard.zh.md)

## Problem

`tool-subagent` with `workerRouteSettings: true` read the Host `subagent-worker-route` setting once per delegation and baked the result into the child's `AgentOptions`. A worker that exhausted its provider's quota therefore kept that route for the rest of its life: an operator could edit the setting, but the only way to apply it was to delegate a replacement, which discarded the failed worker's scene — the files it had read and the conclusions it had reached — exactly when that scene is worth most.

The setting also had no write gate. Form writes reached any namespace at any time, so an edit could land between a worker's prompt assembly and its request routing.

## Decision

A delegation child whose effective route came from the setting records a durable log-only event, `subagent/worker-route`, naming the settings namespace it follows. `tool-subagent` installs `installModelSelection` on each Agent whose log carries that marker: once at the fresh activation, and again from the `agent/created` dispatch when a later activation re-creates the child from its log. The installed selection reference reads `SubagentWorkerRouteConfig.current()` through a getter, so prompt assembly and request routing re-read the setting per request and the standard model-change notice lands in the child's transcript. A host-only `subagentWorkerRoute` projection folds the marker; it is never model-visible.

Only the setting's own route follows the setting. A call that named a route or effort keeps what it named and records no marker, and a tool row without the opt-in never records one.

The same plugin owns this namespace's write guard. `SettingsForms.guard(ns, guard)` is a per-namespace registration point; the write funnel consults every guard before resolving a value and raises `SettingsWriteRefusedError` with the collected reasons. The delegation tool registers the only guard in this release, on its own fiber: a write into `subagent-worker-route-settings` is refused while an Agent whose log carries the marker holds a running turn. The child re-reads the setting at every request, so a rewrite landing while a request is being assembled would change the route of work already on its way to a provider; the predicate cannot tell assembly apart from the gaps between a turn's requests, so the whole turn holds the write, and a settled worker's idle is the window the recovery flow needs. A worker the setting never routed keeps its creation route and never holds the write. `SettingsForms.describe()` publishes the current guard answer as the descriptor's `writeRefusal`, and the Models page disables its three pickers from that published reason; the Host's refusal is the authority. Because the guard is a pull-based predicate, the registration handle's `refresh()` republishes a flipped answer as `settings/document-updated`, and the tool calls it when a marked Agent's status changes — an open Models page watches the lock release instead of waiting for a reload. One Agent takes one selection installation even when several opted-in rows announce the same resumed child; a module-level set keyed by the Agent dedupes the rows' `agent/created` listeners.

## Alternatives considered

**Recreate the worker when the setting changes.** A replacement delegation applies the new route with no new durable state, and it is what an operator does by hand today. It loses the failed worker's scene, which is the reason the recovery flow exists.

**Resolve the route from the setting for every subagent child, with no marker.** The installer could route every `origin: 'subagent'` Agent through the setting. A parent can hold several delegation tool rows with different configuration, and nothing else in the log attributes a child to one row, so an unmarked child created by a plain `subagent` row would lose the route its own tool chose.

**Lock the setting while any subagent exists.** A settled or failed worker stays continuable and listed, so that lock outlives the condition it guards and blocks the recovery it exists to protect.

**Lock the setting while any delegated worker runs.** A child that follows the setting re-reads it at its next request, so a settled worker's route is not in use and holding the write for it would block the very edit the worker is waiting for. Only a request already in flight is at risk, and only for a child the setting actually routed.

**Gate the write in the client only.** The Host owns the profile patch and the Remote API is reachable without the Models page, so a client-side lock would be a suggestion. The disabled controls remain a mirror of the published refusal.

**Re-derive the lock in the client from the Session list.** A client can see which Sessions report `running`, and an earlier revision disabled the pickers from that list. It answers a different question from the one the funnel enforces — it cannot see the marker, and it lags the Host's own state — so the page disabled controls for workers a rewrite would not have touched, and could leave them enabled for one it would.

## Consequences

A settings edit reaches every worker that followed the setting, including one resumed after a restart of the Host process, and the child's own log carries the evidence. The cost is one added event type in the current Session format: a reader older than the event refuses a log that carries it rather than routing a child it cannot reconstruct, so a deployment should not move backwards while a worker's session is in flight. The persistence rules classify an ordinary event-type addition as a same-version change.

The write guard couples `SettingsForms` to nothing new: it runs predicates its registrants own and never inspects Agents itself, and the delegation tool owns the single predicate that does. A deployment that composes no Agent registry leaves that predicate reading an empty list, which always allows the write, because it can have no delegated worker.

The guard lives on the delegation tool's own fiber rather than on the settings owner, because a continuable child outlives the row that delegated it: the row that created a worker is the one whose configuration the worker follows, and a cold resume reinstalls from the marker under whichever row is mounted then.

## Testing

`packages/subagent/tool-subagent/tests/worker-route-reselection.spec.ts` drives the real local-provider stack: a settings change between two turns, a restart over the same store, and an explicit per-call route that records no marker. `worker-route-state.spec.ts` covers the marker and its projection. `worker-route-guard.spec.ts` drives the predicate over real Agents held mid-turn: a following worker holds the write until it settles, a worker the setting did not route never holds it, and a settling worker asks the settings service to republish. The reselection spec also resumes one child under two opted-in rows and asserts a single model-change notice. `packages/settings/settings/tests/configuration.spec.ts` covers the guard registration point and the `writeRefusal` `describe()` publishes; `packages/api/settings-controller/tests/settings-controller.host.spec.ts` covers that field reaching the wire view. The page's disabled state and its refusal notices are covered by `components.client.spec.tsx` and `worker-route.client.spec.tsx`.
