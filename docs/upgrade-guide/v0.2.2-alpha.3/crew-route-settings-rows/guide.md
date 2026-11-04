---
kind: upgrade-guide
description: "The three crew role route-settings rows move from dsh-web-app into dsh-crew, so a web profile shows the crew-route block only when it selects that bundle."
---

# Crew route settings move into the crew bundle

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-web-app` no longer inserts `subagent-worker-route-settings`, `subagent-planner-route-settings`, or `subagent-reviewer-route-settings`. `@deepseek-ai/dsh-crew` inserts them. Those namespaces serve a setting only the crew presets read, so a web deployment that selects no crew bundle served three settings that could not affect anything; the Models page now draws its crew-route block only for the namespaces the Host serves.

`subagent-route-settings-registry` stays in `dsh-web-app`. A deployment that mounts its own `subagent-*-route-settings` row keeps working unchanged, and so does the stored route (`provider`, `model`, `reasoningEffort`), the durable `subagent/worker-route` marker, and every `routeSettingsNamespace` value.

Deployments that select the crew bundle are unaffected unless they also insert one of these three rows themselves: two rows serving one namespace fail the composition with `namespace "…" is already registered by another route-settings row`.

## Migration

1. To keep the crew-route block, add `@deepseek-ai/dsh-crew` to `dsh.profile.bundles` after `@deepseek-ai/dsh-web-app` and install it (`dsh plugin add @deepseek-ai/dsh-crew`). The bundle supplies the three rows with their shipped base routes.
2. If your profile patch inserts any of the three namespace rows, delete those entries: the bundle now owns them. `verify-cordis-config` still requires each entry id to equal its `config.namespace`, and the crew rows already satisfy that.
3. To keep a fourth role route of your own, mount its `subagent-*-route-settings` row anywhere — the registry it injects still comes from `dsh-web-app`. Its namespace appears in `settings.describe()`, but the Models page draws no row for it: the role table in `packages/client/ui-settings-models/src/client/crew-routes.ts` is the page's only row source.
4. Confirm with `dsh --profile <name>`: a profile without the crew bundle lists no `subagent-*-route-settings` namespace in Settings → Models, and one with it lists all three.
