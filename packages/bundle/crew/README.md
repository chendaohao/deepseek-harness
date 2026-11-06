---
description: "Compose a commander and three delegation roles — worker, planner, and reviewer — as Agent presets, each resolving its own model route."
kind: "package-bundle"
---

# @deepseek-ai/dsh-crew

English | [中文](README.zh.md)

## Summary

Compose a commander and three delegation roles — worker, planner, and reviewer — as Agent presets, each resolving its own model route.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle to a profile's `dsh.profile.bundles`, after `@deepseek-ai/dsh-web-app`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-crew"
      ]
    }
  }
}
```

Select the `crew` preset when creating a session. It appears in the preset roster as **Crew**, ordered after the shipped presets.

| Preset | Selected by a person | Role |
|---|---|---|
| `crew` | yes | Commander: reads the request, splits the work, delegates, verifies deliveries, reports |
| `crew-worker` | no | Executor with the full working tool set |
| `crew-planner` | no | Writes a plan; does not change code |
| `crew-reviewer` | no | Returns PASS or FAIL with citations; changes nothing |

Each delegation row reads its own route namespace, so the three roles can run on three different models. This bundle serves those namespaces, so the **Models** settings page shows its crew-route block only in a profile that selects this bundle. Set the routes there under the worker, planner, and reviewer rows; a change reaches a role's next request, including a continuation or a cold resume. With no stored route the row falls back to its `agentOptions` baseline, which the worker row sets from `DSH_CREW_PROVIDER`, `DSH_CREW_MODEL`, and `DSH_CREW_EFFORT`.

Below the rows, the **Model combination** picker saves the three routes under a name and writes all three back on one pick. A combination is all-or-nothing in its outcome: the page preflights every role first and, if a role refuses the write mid-set, puts the roles it already switched back where it found them.

The commander has no general shell or filesystem write/edit tools. Delegate every implementation action to `worker`, including a one-file patch or a single test command. `crew_git` supports the read operations `status`, `diff`, `log`, `show`, `ls-files`, and `rev-parse`; the write operations `checkout`, `reset`, `restore`, `stash`, `clean`, `commit`, `push`, `rebase`, `merge`, and `switch` require user approval. Arguments are literal argv values validated against per-operation option allowlists. Every call applies the Session sandbox policy, disables repository hooks and filesystem monitors, and never invokes a shell or an external remote helper.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package composes its roles through [cordis.patch.yml](cordis.patch.yml), declared by `dsh.bundle.patch`, and exports the commander-only `crew_git` plugin from its Host module. The layer inserts the three `subagent-*-route-settings` rows, the `subagent-route-presets` row, and four `@deepseek-ai/dsh-agent-preset` declarations, so it depends on the host plane `dsh-web-app` composes: the Agent preset registry and the `subagentRouteSettings` registry. The route rows live here, not in `dsh-web-app`, so a web deployment that selects no crew bundle serves no crew route namespace and the Models page shows no crew-route block; a namespace with no serving row makes its delegation row refuse to load rather than silently route to a different role. The preset row is a settings owner with no runtime behavior: it serves the namespace the picker writes, and applying a combination writes each role's own route namespace through that role's row.

Each role preset is mounted only by its delegation row. The commander's `delegation` group holds the three `tool-subagent` rows; `maxDepth: 1` bounds the chain at one level below the commander. `tool-subagent` stopped accepting a `persona` or `toolFilter` config on 2026-10-09, so a role's persona and tools come only from the preset named by its `agentPreset`.

</details>

<a id="model-experience"></a>
## Model Experience

### Commander and role catalogs

#### What the model sees

The commander sees three delegation tools — `worker`, `planner`, and `reviewer` — with role-specific descriptions, plus `send_message`, `list_agents`, and `interrupt_agent` from the control row. It keeps read/search tools and `crew_git`, but no general shell or filesystem writer. Each role child sees its own preset's tool set, narrowed by `preset-tool-mask`, and a persona stating its boundary: the planner writes a plan, the reviewer judges one, neither claims to change code. The reviewer's catalog does not carry a filesystem editor or a task-board writer at all, so its "write nothing except the report" rule is a property of the composition rather than a request the model has to honour.

#### Token effect

The commander's persona is the largest fixed cost in this bundle; it carries the coordination rules that the tool definitions do not enforce. Role children each load their own preset, so no role pays for another role's tools.

#### KV Cache effect

A role child's tool catalog is fixed by its preset, so repeated requests in one child keep a stable prefix. Re-dispatching after a settlement starts a new child and rebuilds the prefix.

## Known Limitations and Deferred Work

- **The roles are siblings, not a gate.** A commander can skip planning or review and delegate straight to a worker. The plan PASS and delivery PASS binding, the digest invalidation when a plan changes, and the evidence manifest that make a gate enforceable are a separate delivery.
- **Role boundaries use different mechanisms.** The commander cannot directly implement because its preset omits general shell and filesystem writers. Each role preset also opens with `preset-tool-mask`, which calls `tools.restrict()` on that preset's scope and narrows the inherited global catalog to the names the declaration keeps. The mask is derived rather than hardcoded, so a deployment mounting an extra plugin narrows that too. Planner and reviewer shell rows remain for their declared read/report workflows; their personas still forbid implementation and long commands.
- **The role presets appear in the preset roster.** The registry has no hidden flag, so `crew-worker`, `crew-planner`, and `crew-reviewer` are offered alongside `crew` when creating a session; their names and `order` values mark them as mounted-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
