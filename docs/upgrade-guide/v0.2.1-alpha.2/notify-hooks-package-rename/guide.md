---
kind: upgrade-guide
description: "The Claude Code hooks bridge package is renamed to @deepseek-ai/dsh-notify-hooks; hook configuration, behavior, and the session producer kind are unchanged."
---

# The hooks bridge is now `dsh-notify-hooks`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-hooks-claude-code` is renamed to `@deepseek-ai/dsh-notify-hooks`. The package still runs a Claude Code `hooks.json` or settings hook config on the same interception seams — SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, and the subagent edges — with the same configuration keys, hook payloads, decisions, and timeouts. The Cordis plugin name changes from `hooks-claude-code` to `notify-hooks`, and log lines that carry the plugin name follow the new name. Session data and hook configurations need no rewrite: the message producer kind stamped on bridge-injected context stays `"hooks-claude-code"`, a released session-format identity that this rename deliberately keeps stable.

## Migration

1. A `cordis.yml` or patch row that mounts the package by name must use `@deepseek-ai/dsh-notify-hooks`; a row id that spells the old package name is worth renaming in the same edit. `dsh plugin add @deepseek-ai/dsh-notify-hooks` installs the new name.
2. A workspace `package.json`, import, or `tsconfig` path that names `@deepseek-ai/dsh-hooks-claude-code` must move to `@deepseek-ai/dsh-notify-hooks`; the old name resolves to nothing after this release.
3. Session data and hook configs carry over untouched: the bridge keeps emitting producer kind `"hooks-claude-code"`, so readers and recorded sessions need no change.
4. Confirm the upgrade: mount the plugin, finish a turn, and check the session log for the `hook/invoked` and `hook/result` pair at the `Stop` point. `pnpm exec vitest run packages/experimental/notify-hooks` covers the bridge.
