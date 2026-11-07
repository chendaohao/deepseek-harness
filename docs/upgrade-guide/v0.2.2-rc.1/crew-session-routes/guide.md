---
kind: upgrade-guide
description: "Crew model combinations become a template library that a new session copies, so the Models page no longer writes the three role route namespaces."
---

# Crew routes are chosen per session

English | [中文](guide.zh.md)

## Change

The Models page's crew block no longer edits the three role route namespaces. It edits a **combination library**: pick a combination, pick one of the three roles, edit that role's provider, model, and reasoning effort, then save. Saving writes only the `subagent-route-presets` settings entry.

A new crew session picks one combination beside the preset chip, and the pick is recorded on that session:

The session's log gains this event before its first turn:

```jsonc
{ "type": "crew/routes-selected", "data": { "presetId": "preset-1", "presetName": "Deep review", "routes": { "worker": { … }, "planner": { … }, "reviewer": { … } } } }
```

Each delegation row resolves its route as *the session's recorded route, else the row's stored namespace*. Consequences:

1. **Editing a combination no longer reaches a session.** A session that already recorded one keeps it. Changing models for a running formation means starting a session on another combination, or repairing one role, not editing the library.
2. **Editing is never blocked by a running role.** The write goes to the library, which no delegation reads directly; only the per-session repair is gated.
3. **A failed delegation is repaired one role at a time.** `crew/route-replaced` records one role's new route, keeps the other two, and stops the session matching its source combination.
4. **A session that recorded nothing keeps reading the role namespaces**, so a deployment that never opens the picker — CLI, API, an older client — behaves as before.

Two settings entries remain and one is added:

```yaml
- id: subagent-route-presets        # the combination library
  name: '@deepseek-ai/dsh-tool-subagent/route-presets'
- id: crew-formation                # per-session ownership
  name: '@deepseek-ai/dsh-crew/formation'
  config:
    worker: subagent-worker-route-settings
    planner: subagent-planner-route-settings
    reviewer: subagent-reviewer-route-settings
```

## Migration

1. Select `@deepseek-ai/dsh-crew` and restart: the bundle inserts the `crew-formation` row, and the block draws one combination editor instead of three role rows.
2. Routes a user set through the old role rows are still the fallback for sessions that recorded no combination. Copy them into a combination on the Models page to make them selectable.
3. A stored blank crew session resumes normally: it recorded no routes, so its delegations keep reading the role namespaces until it is replaced by a session started with a pick.
4. The `crewFormation` Remote namespace (`view`, `selectRoutes`, `replaceRole`) is new; a client older than this version does not call it and needs no change. A viewer client with an endpoint allowlist must classify the three endpoints.
5. Upgrade `@deepseek-ai/dsh-crew`, `@deepseek-ai/dsh-tool-subagent`, and the Client together: a copied session's routes are read by the delegation rows, so an older `tool-subagent` would ignore them.
