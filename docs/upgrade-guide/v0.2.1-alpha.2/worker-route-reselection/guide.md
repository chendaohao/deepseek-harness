---
kind: upgrade-guide
description: "A delegation child that followed the worker-route setting re-resolves its LLM route at every later request, and that setting is locked while a worker runs."
---

# Worker-route children re-resolve their route

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-subagent` with `workerRouteSettings: true` used to bake the `subagent-worker-route` setting into each child at creation, so a later settings edit reached only the next delegation. A child the setting itself routed now records a durable `subagent/worker-route` marker, and every later activation — a cold resume included — re-resolves the provider, model, and reasoning effort from the setting and appends the model-change notice to its next request. A call that named its own route or effort, and a child created by a tool row without the opt-in, keep their creation route.

The same plugin owns a write guard on that namespace: `settings` `update`, `replace`, and `mutate` calls into `subagent-worker-route-settings` are refused while a worker that follows the setting is running: the child re-reads the setting at every request, and a rewrite landing while a request is being assembled would change the route of work already on its way to a provider. Settled and failed workers stay continuable but are not in use, and a worker the setting never routed keeps its creation route, so neither holds the write. The refusal reason is published as the namespace's `writeRefusal` in `settings` `describe()`, and the Models settings page disables its three pickers from that published reason.

## Migration

1. No configuration change is required. `workerRouteSettings: true` keeps its meaning: the setting remains the instance's baseline child route.
2. A script or service that writes `subagent-worker-route-settings` must handle the new refusal. A write attempted while a following worker is running is rejected and names that child: in-process the rejection is `SettingsWriteRefusedError` (`SETTINGS_WRITE_REFUSED`), and over the Remote API the controller maps it to `settings/rejected`. Call `list_agents`, then settle or stop that worker with the control tools before retrying. A form can read the namespace's `writeRefusal` from `settings` `describe()` to disable its controls before the attempt rather than after.
3. A worker that is running when the setting changes now picks the stored route up at its next request instead of keeping its creation route. A reader older than the marked event refuses a log this release wrote, so keep a deployment on one release while a worker's session is in flight.
4. Confirm the upgrade: with no worker running, change the worker route, continue a settled worker, and check its conversation for the model-change notice and the new model on its next request. `pnpm exec vitest run packages/subagent/tool-subagent` covers both directions.
