---
kind: upgrade-guide
description: "Crew model combinations become a template library that a new session copies, so the Models page no longer writes the three role route namespaces."
---

# Crew routes are chosen per session

English | [中文](guide.zh.md)

## Change

The Models page edits a **combination library**, not the three role route namespaces. Saving writes only `subagent-route-presets`. A new Crew session copies its chosen combination onto itself before the first turn:

```jsonc
{ "type": "crew/routes-selected", "data": { "presetId": "preset-1", "presetName": "Deep review", "routes": { "worker": { … }, "planner": { … }, "reviewer": { … } } } }
```

Each delegation reads the session's recorded route, falling back to its role namespace only when none exists. Consequences:

1. **Editing the library changes no existing session.** Use the session header's **Change route** action to replace one role instead.
2. **Library writes never wait for a running role.** Only the per-session repair is gated.
3. **A replacement affects one role.** `crew/route-replaced` preserves the other two and detaches the session from its source combination.
4. **Sessions without a recorded combination keep their old behavior**, including sessions opened through CLI, API, or older clients.
5. **Recording is replaceable until the first turn.** Before that turn, another pick appends a second `crew/routes-selected` and the last event wins; after it, repeating the pick adds no event and a different one fails with `crew/conflict`, keeping the staged choice. A conflict never blocks the first prompt, since the session keeps a valid route set.
6. **Role turns have execution budgets.** `crew-formation.budget` limits steps, wall time, total tokens, and consecutive identical tool failures. Exhaustion records `crew/run-budget-exceeded`; a continuation turn receives fresh budgets.

The relevant settings entries are:

```yaml
- id: subagent-route-presets
  name: '@deepseek-ai/dsh-tool-subagent/route-presets'
- id: crew-formation
  name: '@deepseek-ai/dsh-crew/formation'
  config:
    worker: subagent-worker-route-settings
    planner: subagent-planner-route-settings
    reviewer: subagent-reviewer-route-settings
```

## Migration

1. Select `@deepseek-ai/dsh-crew` and restart. The Crew block shows the combination editor.
2. Existing role routes remain the fallback for sessions without a recorded combination. Save them as a combination to make them selectable.
3. Stored blank Crew sessions resume with that fallback until a newly started session records a pick.
4. Older clients need no `crewFormation` calls. Endpoint-allowlisting viewers must classify `view`, `selectRoutes`, and `replaceRole`.
5. Upgrade `@deepseek-ai/dsh-crew`, `@deepseek-ai/dsh-tool-subagent`, and the Client together; older delegation rows ignore session routes.
6. A refused first-turn combination abandons the submission echo, keeps the draft, and shows the refusal. Upgrade Client and Host together to prevent a silent fallback to role defaults.
7. After a quota or budget stop, select and confirm a replacement in the existing session. This does not retry work; ask the commander to continue the original subagent. Raise `crew-formation.budget` only when a larger limit is intentional.
8. Custom compositions must mount `@deepseek-ai/dsh-token-meter` before `crew-formation` and `@deepseek-ai/dsh-session` before `tool-subagent`; role budgets and child-route recovery read those services. Standard bundles already provide them.
9. Direct session creation or `agentPresets.select` with `crew-worker`, `crew-planner`, or `crew-reviewer` fails with `agent-preset/invalid`. Start the `crew` preset and delegate to those internal roles instead.
