---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, the bounded ceiling recovery, and the compile-command serializer, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for common failure patterns. `repeat-tool-reminder` breaks identical tool-call loops with advice. `timeout-policy` gives a hung tool call a clear timed-out error instead of stalling the session. `max-tokens-recovery` answers a turn that spends its whole output ceiling on reasoning with one bounded recovery prompt, so the agent does not stop silently. `compile-serialization` admits one compile-class command at a time, so concurrent workers in one checkout cannot overwrite each other's build output. The first three ship enabled in the `dsh` base bundle; `compile-serialization` ships disabled because it denies rather than queues.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Small, independent plugins cover one pattern each; every README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`max-tokens-recovery/`](max-tokens-recovery/README.md) | Queues one bounded recovery prompt when a turn burns its whole output ceiling on reasoning |
| [`compile-serialization/`](compile-serialization/README.md) | Admits one compile-class command at a time, so concurrent workers cannot overwrite each other's build output |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-compile-serialization) — every accepted field of the compile-command serializer.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
