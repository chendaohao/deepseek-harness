---
kind: upgrade-guide
description: "Crew role presets now mask the inherited host tool catalog, so a role no longer sees a tool the deployment registered globally unless the preset names it."
---

# Crew role presets mask the host tool catalog

English | [中文](guide.zh.md)

## Change

Every preset in `@deepseek-ai/dsh-crew` now opens with a `@deepseek-ai/dsh-preset-tool-mask` row. It calls `tools.restrict()` on the preset's own scope, so `crew`, `crew-worker`, `crew-planner`, and `crew-reviewer` each see only the global tools their declaration keeps, plus the tools their own rows register. Before this change the four presets inherited every global tool: the reviewer carried the MCP filesystem editors and the task-board writers its persona told it never to use.

A deployment that mounts an extra tool plugin in the profile — an MCP server, an in-house tool row — no longer reaches a crew role unless that preset keeps the name. `crew` and `crew-worker` keep `mcp__codegraph__*`; `crew-planner` keeps the same; `crew-reviewer` keeps `mcp__codegraph__*` and the read half of the MCP filesystem server (`read`, `list`, `get_file_info`, `search_files`, `directory_tree`). Everything else is hidden from those four presets, in this release, without a setting to turn it off.

The host's own agents are unaffected: the restriction is scoped to the preset, so a session running `standard`, `ptc`, or any preset of your own keeps the full catalog.

## Migration

1. Run a crew role once and check the tool catalog it received. A role missing a tool it needs is a preset declaration that does not name that tool.
2. To keep a global tool family in a role, add its name or prefix to that preset's `preset-tool-mask` row in your profile patch. The row accepts `allow`, `allowPrefixes`, `deny`, and `denyPrefixes`; every global name no list keeps is hidden.
3. To keep one member of a family you already keep, add it to `deny`. A name in both `allow` and `deny` is denied, so a broad `allowPrefixes` entry plus one `deny` entry expresses "the family except this one".
4. A name in `allow` that your deployment does not register is reported once as a warning and ignored; the preset still mounts, so a shared preset keeps working where an optional plugin is absent.
5. To restore the previous behavior for a role, delete that preset's `preset-tool-mask` row from your patch. The preset then inherits the whole catalog again, and its persona's boundaries become advisory as they were before.

Confirm with `dsh --profile <name>`: a `crew-reviewer` session lists no `mcp__filesystem__write_file` or `mcp__filesystem__edit_file` in its tool catalog, and a `crew-worker` session lists no tool your deployment registered globally unless the preset names its family.
