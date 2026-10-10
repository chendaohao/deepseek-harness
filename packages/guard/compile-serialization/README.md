---
description: "Compile-command serialization guard that admits one install, build, typecheck, or coverage command at a time and denies a concurrent one with a retryable message, for users and maintainers coordinating several agents in one checkout."
kind: "package-reference"
---

# @deepseek-ai/dsh-compile-serialization

English | [中文](README.zh.md)

## Summary

Use this package when several agents share one checkout and their install, build, typecheck, and coverage commands would overwrite each other's `node_modules`, `lib/`, `dist/`, and `.tsbuildinfo` output. It admits one compile-class command at a time and denies a concurrent one with a message naming the running command and the session that started it, so the model can wait and retry. It is off by default in the `dsh` base bundle because it denies rather than queues; enable it where concurrent workers share a working tree.

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

The common path is one row: add the plugin to the composition. The base bundle ships it switched off, so a base-backed profile enables it with an overlay row.

### When to choose it

Choose it when more than one agent runs shell commands in the same checkout — a Crew-style deployment delegating work to subagents, or a workflow running several children over one workspace. Avoid it when agents never share build output, because the guard turns a harmless concurrent call into a denial, and when a compile command may legitimately outlive the configured lease, because the next compile command then preempts it.

### Setting it up

Enable the row the base bundle ships disabled:

```yaml
- id: compile-serialization
  disabled: false
```

Tune the recognized commands and the two bounds with configuration:

```yaml
- id: compile-serialization
  disabled: false
  config:
    commandPatterns:
      - '\b(?:pnpm|npm)\s+(?:install|ci)\b'
      - '\bmake\s+build\b'
    toolNames: [bash]
    commandPreviewChars: 160
    leaseTimeoutMs: 7200000
```

| Field | Default | Meaning |
|---|---|---|
| `commandPatterns` | install/build/typecheck/coverage, `tsc --build`, `vitest`/`jest` with `--coverage`, and `vite`/`tsdown`/`webpack`/`rollup`/`esbuild build` | Regular-expression sources matched against a command's text; any match is compile-class |
| `toolNames` | `[bash, pwsh]` | Tool names whose `command` argument is inspected |
| `commandPreviewChars` | `120` | Maximum characters of the running command quoted in the denial |
| `leaseTimeoutMs` | `3600000` | Age after which a still-registered command is treated as leaked and the next compile command may take the slot |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compile-serialization) is the exhaustive source for every accepted field.

### What you get

One compile-class command runs; a second one issued while it is in flight is denied with `Error: another compile-class command is still running: <tool> in session <id> started <n>s ago: "<command>". …retry this command after that one finishes.` The denial is an ordinary error result, so the model can wait and retry the call instead of concluding the deployment is broken.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how one synchronous guard serializes commands across every agent in the process, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **Deny, never queue.** `ctx.tools.guard()` is synchronous and returns only a reason or `undefined`, so the guard cannot wait for the running command. It denies the later call with a retryable message and leaves the waiting decision to the model.
- **One process-global slot.** A process may hold two copies of this package — a built `lib/` bundle and `src/` — and a per-module table would let each copy admit a command. The in-flight registration therefore lives in a table keyed by `Symbol.for('dsh.guard.compile-serialization.in-flight')`, the same cross-copy identity mechanism `dsh-tools` uses for its scheduler symbol.
- **Compile-class is configured, not hardcoded.** The pattern table and tool list are validated `Config` fields, so a deployment names its own build commands instead of inheriting an opinion.
- **The registration cannot leak.** Every admitted execution reaches `tools/result` — including a denial, a tool error, and a cancellation — so that emit releases the exact admitted token. Two further release paths cover the cases that never reach a result: a caller signal that aborts makes its registration reclaimable at once, and plugin disposal clears any registration this instance owns.

### How a command is serialized

One monotonic guard reads the call's `command` argument when the tool name is in `toolNames` and any configured pattern matches. With no live registration it records the execution token, tool name, agent id, caller signal, and start time, and abstains. With a live registration it returns the denial naming what runs. The leak valve treats a registration as reclaimable when its caller signal is aborted or when it has been held longer than `leaseTimeoutMs`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`Config`/`apply`, the process-global table, the guard, and the three release paths |
| — | No runtime invariant companion is published; the package owns one process-global cell, and its single owned relation (a registration is cleared only by its own execution) is enforced and tested in `src/index.ts` rather than observed independently. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the guarded execution pipeline, the `ToolGuard` type, and the `tools/result` event this plugin releases on.
- [Defensive patterns](../../../docs/defensive-patterns.md) — the lifecycle and concurrency rules the release paths follow.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compile-serialization) — every accepted field of this plugin.

-----

<a id="model-experience"></a>
## Model Experience

### Concurrent compile-command denial

#### What the model sees

One error result for a compile-class call issued while another compile-class command is in flight, naming the running tool, its session, its elapsed time, and a truncated copy of its command. Every other call, including a non-compile shell command, is unchanged; no prompt or tool schema changes. The denial text is `another compile-class command is still running: <tool> in session <id> started <n>s ago: "<command>"`.

#### Token effect

Zero tokens on an admitted call. A denial adds one retained error result of a few dozen tokens and prevents a compile command that would have corrupted shared build output.

#### KV Cache effect

Append-only: the denial follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Denial, not queueing** — the guard cannot wait for the running command, so the denied call fails immediately and the model must retry. A deployment that needs automatic queueing needs an asynchronous wrapper over `tools/execute`, which this guard deliberately is not.
- **Pattern matching, not command parsing** — a compile-class command written in a form no configured pattern matches (a custom script name, a `make` target, a shell alias) is not serialized. Add the pattern or accept the gap.
- **One slot per process, not per checkout** — the table is process-global, so two agents building unrelated checkouts in one process also serialize. That is deliberate (the alternative needs per-workspace identity), but it costs throughput when the deployments are independent.
- **The lease valve can preempt a slow command** — a legitimate compile command that runs longer than `leaseTimeoutMs` is treated as leaked and its slot is taken. Raise the field when one command can exceed it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The base bundle ships the row `disabled: true`. A future change could derive the enablement from whether the composition can delegate to subagents, which is the condition that makes the guard worthwhile, instead of asking each deployment to opt in.

</details>