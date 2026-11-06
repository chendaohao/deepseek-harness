---
kind: upgrade-guide
description: "The crew bundle serves a new subagent-route-presets namespace, so the Models page can save named combinations of the three role routes and switch all of them at once."
---

# Saved crew route combinations

English | [中文](guide.zh.md)

## Change

The Models page's crew-route block gained a combination picker. A combination is a named snapshot of every role's route: picking one writes the worker, planner, and reviewer route namespaces, so switching "which models the formation runs on" is one pick instead of three edits.

The stored list lives in a new settings namespace, `subagent-route-presets`, served by a new row the crew bundle inserts:

```yaml
- id: subagent-route-presets
  name: '@deepseek-ai/dsh-tool-subagent/route-presets'
  config:
    presets: []
```

The shipped list is empty. Nothing else changes: the three role route namespaces, their stored values, the durable `subagent/worker-route` marker, and every `routeSettingsNamespace` value keep their current meaning.

## Migration

1. Deployments that select `@deepseek-ai/dsh-crew` need no action beyond a restart: the bundle inserts the row, and the picker appears above the role rows.
2. A deployment that installs the crew bundle from a pinned version older than this one sees no picker, because the Host serves no preset namespace. Upgrade `@deepseek-ai/dsh-tool-subagent` and `@deepseek-ai/dsh-crew` together.
3. A deployment that composes its own route rows outside the crew bundle serves no preset namespace and shows no picker. Its routes keep working exactly as before; the combination feature is scoped to the crew bundle.
4. A profile patch that already inserts `subagent-route-presets` must not also select the crew bundle: two rows serving one namespace fail the composition the same way two route rows do.
5. Confirm in Settings → Models: with the crew bundle the block shows a **Model combination** picker above the three roles; without it, neither the picker nor the role rows appear.
