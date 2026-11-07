---
kind: upgrade-guide
description: "A preset can declare userSelectable: false, so the crew delegation roles stop appearing in the new-session picker and can no longer start a session."
---

# Crew role presets are no longer selectable

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-agent-preset` accepts a new optional field, `userSelectable`. It defaults to true; a preset that declares `false` is mounted only by another preset's composition and never starts a session of its own.

The crew bundle declares its three delegation roles with it:

```yaml
- id: preset-crew-worker
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: crew-worker
    name: Crew Worker
    order: 99
    userSelectable: false
    description: 'Crew executor preset, mounted by the crew preset''s worker tool; not for creating sessions.'
```

Two surfaces filter on it, and one refuses:

1. The new-session picker and the presets page offer only presets whose flag is absent or true. A broken internal preset stays visible, because that is a deployment fault someone has to see.
2. `session.create` with a `userSelectable: false` preset is refused with `agent-preset/invalid`. Before this change it created a session that ran a role persona with no commander above it, which silently has no delegation target.
3. `AgentPresetRow.userSelectable` carries the flag to the client. An ordinary preset omits it, so an existing client that ignores the field behaves exactly as before.

The internal mount is untouched: a `tool-subagent` row names its role by `agentPreset` id and reaches the registry through `mount`, which never consults the flag.

## Migration

1. Select `@deepseek-ai/dsh-crew` and restart: the picker and the presets page list only **Crew**, and both README tables now say so.
2. Nothing to change for a deployment that never named `crew-worker`, `crew-planner`, or `crew-reviewer` in `session.create`. One that did now receives `agent-preset/invalid`; start a `crew` session and delegate instead, because the role has no delegation tool of its own.
3. An out-of-repo preset used only as a `tool-subagent` `agentPreset` target should declare `userSelectable: false` to leave the picker. Leaving it out keeps today's behavior, which is still valid.
4. A stored blank Session created on a role preset is unaffected: resuming it reads the recorded preset, not the roster flag.
