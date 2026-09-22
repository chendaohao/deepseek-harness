# Agent Note: Paced unattended goal rounds

Status: implemented

English | [中文](2026-09-22-paced-goal-rounds.zh.md)

## Problem

The driver reserved a round at every idle point. With an armed goal, a finished turn immediately queued the next one, so an unattended goal waiting on background work re-entered the model as fast as its own turns completed rather than at the rate its situation changed.

A measured orchestration session made the cost concrete: 16 rounds in 7 minutes, 1.6M tokens, about 11% of that session's commander spend, and no progress in any of them. Each round is a full request over a context already near 300K tokens, so the loop scales with idle time instead of with work. It ended only because a human paused the goal in the UI, and the operator's preset had to carry prose telling the model to pause its own goal when rounds stop making progress — guidance the model followed after 16 rounds, not before.

A round is the only autonomous wake-up the driver owns, so an unthrottled one also decides how often a waiting goal spends money.

## Decision

[`@deepseek-ai/dsh-goal-round-driver`](../../../../packages/goal/goal-round-driver/) takes a `roundIntervalMs` Config field, in milliseconds, defaulting to `1800000` (30 minutes). It is the driver's only setting; `maxGoalRounds` stays in the goal definition and the blocked threshold stays in `dsh-tool-goal`, because those are policy the driver must not own twice.

The interval is a minimum spacing between reservations, not an idle timer. The gate sits in `drive()` immediately before the reservation, so no trigger path can bypass it — every `requestDrive` caller, including the timer itself, re-enters the same check. An idle point inside the interval arms one timer for the remainder and returns; the timer is `unref`'d so a pending round never holds the host process open.

Two conditions skip the wait. A goal whose `roundsStarted` is still 0 has no previous reservation, so its first round starts at the next idle point. An explicit `goal/changed` — create, edit, resume — clears the recorded reservation time, because a lifecycle mutation is fresh authorization rather than unattended drift.

Teardown and agent disposal cancel a pending timer, so an unloaded driver cannot wake a lifecycle it no longer owns. The reservation timestamp is process-local scheduling state: it is not durable, and a reload resumes with no memory of the previous interval.

This supersedes the "plugin has no configuration" contract of [Same-session goal-round driver](../../archived/feature/2026-07-19-same-session-goal-round-driver.md); that note's reservation, fence, checkpoint, and teardown decisions stand unchanged.

## Alternatives considered

**Detect no-progress rounds and back off.** The driver would need a definition of progress, and every candidate it can observe from here — tool calls, output length, workspace diffs — is a proxy the model can satisfy while making no progress. The measured session's rounds did call tools; they ran the same `git status` five times.

**A per-goal `round_interval_ms` on `create_goal`.** This is the only way to give one goal a different cadence from another, and it was rejected for its reach: the goal record is durable, so the field enters the session format, the fold schema, the tool schema, both SDK expected outputs, and every goal snapshot, and the model must remember to pass it on every create. A host setting covers the observed need — unattended orchestration is the only goal use in practice.

**Keep the immediate re-arm and let the model pause its own goal.** This was the shipped behavior, and the preset carried the instruction. It relies on the model recognizing a spin it has no cheap way to measure, and it spends the tokens before the model can decide.

**Make the first round wait out the interval too.** Uniform and simpler, but creating a goal would then do nothing for 30 minutes. The reservation is the natural boundary: the first one has no predecessor to be paced against.

**Back off exponentially instead of a fixed interval.** Responsive early and cheap late, but it makes the wake-up schedule a function of round count rather than of elapsed time, and no operator can predict when the next round lands.

## Consequences

An unattended goal costs one model request per interval instead of one per idle point. In the measured session the pathological window — 16 rounds in 7 minutes — collapses to a single round, and the human intervention that ended the loop is no longer needed. The 30-minute default changes behavior for every existing goal user, not only the deployment that reported the cost; `roundIntervalMs: 0` restores the previous behavior, and the scenarios that assert an exact round sequence now set it explicitly.

The trade-off is latency the driver cannot shorten. A goal whose next step depends on nothing external now advances one round per interval, where it previously advanced as fast as the model could run. Worker and subagent settlements still wake the session immediately, so goals that wait on delegated work keep their responsiveness; goals that wait on the model's own next thought do not.

The interval is wall-clock, so a forward clock jump can shorten one interval and a backward jump can lengthen one. Both are harmless for a pacing floor, and neither is worth a monotonic clock the rest of the scheduling surface does not use.

A rejected reservation now also consumes the interval. That is deliberate — it is what makes the rate limit unbypassable — and it means a goal edited mid-interval continues on the new revision only after the interval, unless the edit itself re-authorizes an immediate round.
