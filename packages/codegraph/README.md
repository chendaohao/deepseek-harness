---
description: "The codegraph group map: CodeGraph integration for indexed workspaces, for users and maintainers choosing or configuring the plugin."
kind: "package-group"
---

# codegraph/ — CodeGraph integration

English | [中文](README.zh.md)

## Summary

The codegraph group integrates the CodeGraph code-index CLI into dsh sessions whose workspace carries a `.codegraph/` index. One package implements it: `dsh-codegraph` folds a scoped CodeGraph checklist into the first pre-step batch of such sessions and lazily starts one `codegraph serve --mcp` connection whose tools register as `mcp__codegraph__*`. Workspaces without an index get nothing — no message, no server, no tools — and a missing or broken CLI degrades to the `codegraph explore` shell fallback with a logged warning, never a failed session. This page maps the group; the package README owns the per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`codegraph/`](codegraph/README.md) | Scoped CodeGraph checklist + lazily started `codegraph serve --mcp` connection | — |

-----

<a id="related-documentation"></a>
## Related documentation

- [CodeGraph package README](codegraph/README.md) — the per-package contract, configuration, and Model Experience.
- [Configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-codegraph) — every accepted `dsh-codegraph` config value.
- [Agent Note: CodeGraph integration for indexed workspaces](../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.md) — design decisions and alternatives.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [CodeGraph integration feature note](../../.agents/notes/implemented/feature/2026-08-16-codegraph-integration.md) records the design: one plugin on the agent pre-step waterfall and the mcp-client connection API, with no core changes.

</details>
