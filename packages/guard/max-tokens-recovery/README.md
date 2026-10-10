---
description: "Loop-hygiene guard that gives a turn one bounded recovery when it spends its whole output ceiling on private reasoning, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-max-tokens-recovery

English | [中文](README.zh.md)

## Summary

A provider can stop a step at its output-token ceiling while that step streamed only private reasoning. The turn then ends with no visible text and no tool call, so the agent stops making progress while its transcript still looks healthy — the failure is invisible to anyone reading the conversation. This package notices that step and queues exactly one short recovery prompt for the next turn, telling the model to deliver the smallest concrete change instead of re-planning. It recovers once per run of consecutive ceiling hits, and the `dsh` base bundle enables it with `maxRecoveries: 1`. Delegated child sessions are left to their parents unless `coverSubagentSessions` turns coverage on.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when agents run unattended on tasks big enough for a model to deliberate past its output ceiling. There is nothing to wire: the `dsh` base bundle already runs it, and the single default works for most sessions.

### When to choose it

Choose it when an agent that stops silently is expensive — a background worker, an unattended goal round — and spending one extra request to find out whether the model can still deliver is cheaper than discovering days later that nothing was written. Skip it when every ceiling hit is meaningful on its own and an automatic retry only duplicates work.

### Setting the recovery budget

```yaml
- name: '@deepseek-ai/dsh-max-tokens-recovery'
  config:
    maxRecoveries: 1           # recovery prompts per run of consecutive ceiling hits
    coverSubagentSessions: false   # also recover delegated child sessions
```

| Field | Default | Meaning |
|---|---|---|
| `maxRecoveries` | `1` | Recovery prompts allowed per run of consecutive ceiling hits; `0` disables the guard |
| `coverSubagentSessions` | `false` | Also recover sessions whose header names a parent session (delegated children) |

A run ends as soon as a step commits visible text or requests a tool call, so an agent that does recover becomes eligible again the next time it burns its ceiling. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-max-tokens-recovery) documents every accepted value.

### Covering delegated child sessions

A delegated child's budget belongs to the parent that started it: a one-shot child owes its caller one result, and a continuable one reports through its settlement notice, so by default the guard leaves the child's ceiling alone. That default is wrong when a worker burns its ceiling unattended and the parent is waiting on a result that will never arrive. Setting `coverSubagentSessions: true` recovers the child too, once per run, bounded by the same `maxRecoveries`; the child's prompt asks for the smallest concrete result instead of the smallest next change, because the caller needs an answer rather than further work.

### What you get

With the default, an agent that spends its whole ceiling on reasoning receives one short prompt asking for the smallest concrete next change. If its next turn produces work, the run is over. If it burns the ceiling again, the guard stays quiet and the turn ends as it would have without the guard, so the worst case is one extra request rather than an unattended retry loop.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard recognizes the failure and queues its recovery; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The ceiling only.** A turn can also end with nothing visible because a parent stopped it or a policy rejected it. Those are not output-budget failures, and naming the ceiling for them would aim the next attempt at a constraint that never bit.
- **Both halves are required.** A step that requested a tool call is progress even if it emitted no text, and a step that emitted text did work even if it then hit the ceiling; neither is the silent stop this guard exists for.
- **One recovery, then stop.** The guard gives an agent one chance to deliver and then steps out of the way. An escalating retry budget turns one slow interaction into an unattended loop.

### Detection

The guard reads `session/event` and keeps a `WeakMap<Agent, {recoveries}>` run counter. For each settled `assistant/message` or `assistant/attempt` it asks three questions of the step's own compact stream, using the shared readers rather than re-deriving them: does it carry visible text (`assistantStreamHasVisibleText`)? does it carry a tool call? does its final `finish` chunk say `max-tokens`? Only a step that answers no, no, yes is the failure.

Because the counter resets on any step that committed work, the budget is per run of consecutive ceiling hits rather than per session — an agent that recovers is eligible again later.

### Recovery delivery

The recovery is an ordinary `user/message` with source `{kind: 'max-tokens-recovery'}`, queued through `Agent.followup`, so it opens its own turn: a ceiling step closes the turn it ended, and extending that turn is not an option. The listener defers the queue with `queueMicrotask`, because `session/event` is delivered inside the append that publishes it and an append rejects any reentrant append — the one a queue mutation would perform.

A delegated child's ceiling is its parent's concern by default, so the guard ignores every session whose header names a parent session. A one-shot child owes its caller a single result, and a continuable one reports through its settlement notice; recovering inside the child would answer for a caller that never asked and would overwrite the stop reason that caller needs. `coverSubagentSessions` opts into covering those sessions anyway, and the listener then selects the child prompt below.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the ceiling predicate, and the deferred recovery |
| — | No runtime invariant companion is published; the run counter is private to one listener and exposes no package-owned event an independent companion can observe. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent loop](../../core/agent-loop/README.md) — the turn and step boundaries, and where a ceiling ends a turn.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-max-tokens-recovery) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.
- [Subagent settlement notice](../../subagent/subagent/README.md#settlement-notice) — how the parent learns the same failure from a delegated child.

-----

<a id="model-experience"></a>
## Model Experience

### Ceiling recovery prompt

#### What the model sees

One user-role turn, queued after a turn that streamed only reasoning and stopped at the ceiling. A covered delegated child receives the same turn with the deliverable named as a result instead of a next change. Nothing is appended to a step, and no tool schema changes.

##### The recovery prompt

```markdown
Your previous turn hit the output token ceiling before emitting any visible text or tool call, so it produced nothing. Do not restate the plan or re-derive the design: make the single smallest concrete change or tool call that moves the work forward, and keep the explanation to one short sentence.
```

##### The delegated child prompt

```markdown
Your previous turn hit the output token ceiling before emitting any visible text or tool call, so it produced nothing. Do not restate the plan or re-derive the design: deliver the smallest concrete result or tool call that moves the work forward, and keep the explanation to one short sentence.
```

#### Token effect

Zero tokens until a ceiling hit. One retained prompt plus one model request per eligible hit, bounded by `maxRecoveries` per run.

#### KV Cache effect

Append-only: the prompt follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Only the ceiling is recognized** — a turn that stalls for any other reason, including a provider that reports a different truncation signal, is out of scope.
- **The recovery is generic** — the guard names the constraint but cannot describe the task; a more specific instruction would need a consumer that knows the work.
- **A recovered agent can still fail** — the prompt improves the odds of a concrete next action and does not guarantee one.
- **The counter is process-local** — a session resumed from persistence starts a fresh run, so a burn spanning a resume gets a second recovery.
- **Text-only evidence of progress** — a step that streamed only a tool call counts as work irrespective of whether that call succeeded.
- **Child coverage is opt-in and unproven against live subagents** — `coverSubagentSessions` is exercised against a child session built by the agent registry, not through a real delegation; a covered child's caller may still need its original stop reason.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
