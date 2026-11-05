---
description: "Preset-scoped mask over the host global tool catalog, so a role preset sees only the tools its declaration keeps, for preset authors who need a narrowed tool surface rather than a narrowed persona."
kind: "package-reference"
---

# @deepseek-ai/dsh-preset-tool-mask

English | [中文](README.zh.md)

## Summary

A preset can add plugin rows and shadow same-named ones, but nothing in a preset removes a global tool. A reviewer preset that declares only `read` and `write` still carries the deployment's shell, MCP filesystem editors, task board, and every other host-global tool, and its persona has to ask the model to ignore them. This package closes that gap. Mounted as the first row of a preset, it restricts that preset scope's view of the global catalog to the names the declaration keeps, and every Agent composed under the preset inherits the restriction. The host's own agents keep the full catalog.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it as the first row of a preset whose roles must not hold the deployment's whole tool catalog. The row belongs to the preset, not to the profile: the same profile serves a full-access agent and three narrowed roles.

### When to choose it

Choose it when a preset's persona tells the model not to use a capability the deployment nevertheless gives it. The mask makes the narrowing real instead of advisory, and it shrinks the tool schema the model pays for on every request. Avoid it when the preset genuinely needs the host catalog, and when the deployment mounts tools after preset load that no prefix covers — a tool registered by a plugin name this declaration does not predict stays visible only until the next `tools/change`.

### Declaring the mask

```yaml
- id: preset-tool-mask
  name: '@deepseek-ai/dsh-preset-tool-mask'
  config:
    allow: [read, write, bash, todo_write]
    allowPrefixes: ['mcp__codegraph__']
    deny: [task_board_run]
```

| Field | Default | Meaning |
|---|---|---|
| `allow` | `[]` | Exact global tool names this preset keeps |
| `allowPrefixes` | `[]` | Name prefixes this preset keeps, for families whose members vary by deployment |
| `deny` | `[]` | Exact names dropped after the allow lists; used to cut one member of a kept family |
| `denyPrefixes` | `[]` | Prefixes dropped after the allow lists |

Every global tool not kept by `allow` or `allowPrefixes` is hidden. The preset's own rows are unaffected: a tool the preset registers itself stays visible even when no allow entry names it.

### What you get

The model in that preset receives only the kept schemas, so the tool catalog it reads on every request matches what its persona asks it to do. An `allow` name the deployment does not register is reported once as a warning and ignored, so one shipped preset still mounts where an optional plugin is absent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

The mask is derived, not enumerated. Expanding `allow` and `allowPrefixes` against the live global catalog means a deployment mounting extra plugins narrows those too, without editing the preset; the alternative — the preset listing every tool to drop — goes stale the moment another plugin loads. `tools/change` re-expands the mask, so a tool that arrives after the preset mounted is hidden rather than leaking in.

The restriction is applied to the preset scope, not to a context-global table. Agents composed under the preset are parented to that scope, and the tool registry intersects restrictions along the scope chain, so narrowing one preset leaves every other agent's catalog intact.

### Source map

| Module | Responsibility |
|---|---|
| `src/index.ts` | `Config` validation, the derived deny list, and the `tools/change` refresh |

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools](../../core/tools/README.md) — the registry, the per-scope restriction, and the scope chain the mask rides.
- [Agent preset](../../preset/agent-preset/README.md) — the composition this row belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Narrowed tool catalog

#### What the model sees

Only the kept schemas. A preset that keeps four tools out of a hundred issues a catalog a fraction of the size, charged on every request of the session. A tool the mask hides is absent from the catalog entirely: the model does not read its name, its description, or its parameter schema, and a call it attempts from memory settles as `UNKNOWN_TOOL`.

#### Token effect

Token counts fall with the catalog: the removed schemas stop being resent. The mask itself adds no message, no prompt section, and no tool.

#### KV Cache effect

The catalog is prefix-stable while the kept set does not change. A `tools/change` that alters the kept set re-sends the catalog from the first difference, exactly as a tool registration would.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the mask is a poor fit. They are current package constraints, not a task backlog.

- **Hidden is not forbidden** — the mask removes a schema from the model's catalog; it does not reject a call made from a stale one. Such a call reaches the executor and settles as an unknown tool, which the preset sees as an ordinary tool failure.
- **Prefixes cover names, not intent** — a tool the deployment registers after the preset mounted, under a name no declared prefix matches, cannot be kept by the preset; the refresh hides it like any other unkept tool.
- **The declaration binds to a preset revision** — editing it re-mounts the preset, so Agents already running under the previous revision keep the previous mask until they restart.
- **The mask cannot widen** — a preset keeps what the host registers. A tool the host never mounted cannot be named into existence, and an `allow` entry for it is a warning.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The package directory is deliberately not named `tool-*`: the tool-catalog generator boots every `packages/*/tool-*` package as a shipped tool and refuses a package that registers none.

The alternative design — letting a preset declare `toolFilter` on its delegation row — was removed on 2026-10-09 because the filter belonged to the child's composition, not to the parent's call. The mask keeps that decision and moves the narrowing to where the composition lives.

</details>
